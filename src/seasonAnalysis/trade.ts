import type { LeaguePlayer, LeagueTeam } from '../features/season/model.ts';
import type { LeagueEvaluator } from './analyzeLeague.ts';
import type { LeagueAnalysis } from './model.ts';
import { capacityIssues, rebuildTeam } from './rosterMoves.ts';
import { categoryStandings, compareTeam, isReady, type TeamImpact } from './teamInsights.ts';
import { unsetGoals, type SeasonCategoryGoals } from './strategy.ts';

/** What-if only. Moves reference real ESPN IDs and the owner in the starting snapshot;
 * nothing is sent to ESPN and source rosters are never modified. */
export type TradeTarget = number | 'waiver';
export interface TradeMove { playerId: number; sourceTeamId: number; target: TradeTarget }
export interface TradeScenario { schemaVersion: 1; moves: TradeMove[]; history: TradeMove[][] }
export const emptyScenario = (): TradeScenario => ({ schemaVersion: 1, moves: [], history: [] });

const ownerOf = (teams: readonly LeagueTeam[], playerId: number) => teams.find(t => t.roster?.some(p => p.espnPlayerId === playerId));
/** One effective target per player: a new target replaces the old one; sending a player
 * back to the starting owner removes the move. Each edit is one undo step. */
export function moveScenario(s: TradeScenario, teams: readonly LeagueTeam[], move: TradeMove): { scenario: TradeScenario } | { error: string } {
  const owner = ownerOf(teams, move.playerId);
  if (!owner) return { error: 'Oyuncu başlangıç kadrolarında yok.' };
  if (owner.espnTeamId !== move.sourceTeamId) return { error: 'Oyuncunun başlangıç takımı doğrulanamadı.' };
  if (move.target !== 'waiver' && !teams.some(t => t.espnTeamId === move.target)) return { error: 'Hedef takım ligde yok.' };
  const existing = s.moves.find(m => m.playerId === move.playerId);
  if (move.target === move.sourceTeamId && !existing) return { error: 'Oyuncu zaten bu takımda.' };
  if (existing && existing.target === move.target) return { error: 'Oyuncunun hedefi zaten bu.' };
  const others = s.moves.filter(m => m.playerId !== move.playerId);
  const moves = move.target === move.sourceTeamId ? others : [...others, move];
  return { scenario: { schemaVersion: 1, moves, history: [...s.history, s.moves] } };
}
export const undoScenario = (s: TradeScenario): TradeScenario => s.history.length ? { schemaVersion: 1, moves: s.history.at(-1)!, history: s.history.slice(0, -1) } : s;
export const resetScenario = (s: TradeScenario): TradeScenario => s.moves.length || s.history.length ? { schemaVersion: 1, moves: [], history: [...s.history, s.moves] } : s;

/** Re-checks every move against a (possibly refreshed) snapshot; invalid moves are
 * dropped and reported, never applied silently. */
export function revalidate(s: TradeScenario, teams: readonly LeagueTeam[]): { scenario: TradeScenario; removed: TradeMove[] } {
  const removed: TradeMove[] = [], moves: TradeMove[] = [];
  for (const m of s.moves) {
    const owner = ownerOf(teams, m.playerId);
    if (!owner || owner.espnTeamId !== m.sourceTeamId || m.target !== 'waiver' && !teams.some(t => t.espnTeamId === m.target) || m.target === m.sourceTeamId) removed.push(m); else moves.push(m);
  }
  return { scenario: removed.length ? { schemaVersion: 1, moves, history: [] } : s, removed };
}
/** Atomic application. Ownership partition invariant: every starting player ends with
 * exactly one owner (a team or the waiver pool). */
export function applyScenario(teams: readonly LeagueTeam[], s: TradeScenario): { teams: LeagueTeam[]; waiver: LeaguePlayer[] } {
  const players = new Map(teams.flatMap(t => (t.roster ?? []).map(p => [p.espnPlayerId, p] as const)));
  const out = new Map<number, Set<number>>(), incoming = new Map<number, LeaguePlayer[]>(), waiver: LeaguePlayer[] = [];
  for (const m of s.moves) {
    const p = players.get(m.playerId)!;
    out.set(m.sourceTeamId, (out.get(m.sourceTeamId) ?? new Set()).add(m.playerId));
    if (m.target === 'waiver') waiver.push(p); else incoming.set(m.target, [...incoming.get(m.target) ?? [], p]);
  }
  const next = teams.map(t => out.has(t.espnTeamId) || incoming.has(t.espnTeamId) ? rebuildTeam(t, out.get(t.espnTeamId) ?? new Set(), incoming.get(t.espnTeamId) ?? []) : t);
  const seen = new Map<number, number>();
  for (const p of [...next.flatMap(t => t.roster ?? []), ...waiver]) seen.set(p.espnPlayerId, (seen.get(p.espnPlayerId) ?? 0) + 1);
  if (seen.size !== players.size || [...seen.values()].some(n => n !== 1) || [...players.keys()].some(id => !seen.has(id))) throw new Error('Senaryo sahiplik bütünlüğü bozuldu.');
  return { teams: next, waiver };
}

export interface TradeEvaluation {
  moves: TradeMove[]; blockers: string[]; notes: string[];
  before: LeagueAnalysis; after: LeagueAnalysis | null;
  /** Every team, including teams whose roster did not change. */
  impacts: TeamImpact[]; involved: number[];
}
export function simulateTrades({ evaluator, teams, baseline, slots, scenario, myTeamId, goals }: {
  evaluator: LeagueEvaluator; teams: readonly LeagueTeam[]; baseline: LeagueAnalysis; slots: readonly { slotId: number; count: number }[];
  scenario: TradeScenario; myTeamId: number; goals: SeasonCategoryGoals;
}): TradeEvaluation {
  const notes: string[] = [], involved = [...new Set(scenario.moves.flatMap(m => m.target === 'waiver' ? [m.sourceTeamId] : [m.sourceTeamId, m.target]))].sort((a, b) => a - b);
  const empty = { moves: scenario.moves, before: baseline, after: null, impacts: [], involved };
  if (!isReady(baseline)) return { ...empty, blockers: ['Mevcut lig analizi hazır değil.'], notes };
  if (!scenario.moves.length) return { ...empty, blockers: ['Senaryoda hamle yok.'], notes };
  const { scenario: valid, removed } = revalidate(scenario, teams);
  if (removed.length) return { ...empty, blockers: ['Bazı hamleler güncel kadrolarla uyuşmuyor; senaryoyu yeniden kur.'], notes };
  const { teams: next } = applyScenario(teams, valid);
  const capacity = next.flatMap(t => capacityIssues(t, slots));
  if (capacity.length) return { ...empty, blockers: [...capacity, 'Kapasiteyi aşan takımdan bir oyuncuyu waiver’a göndererek dengeleyebilirsin.'], notes };
  for (const m of valid.moves) {
    const p = teams.find(t => t.espnTeamId === m.sourceTeamId)!.roster!.find(x => x.espnPlayerId === m.playerId)!;
    if (p.placement === 'ir') notes.push(`${p.name} IR'de; yeni takımda da IR yerinde değerlendirilir ve hesaba katılmaz.`);
  }
  const after = evaluator.evaluate(next);
  if (!isReady(after)) return { ...empty, after, blockers: ['Senaryo sonrası lig analizi hesaplanamadı (eksik projeksiyon veya slot uygunluğu).'], notes: [...notes, ...(after as LeagueAnalysis).teams.filter(t => !t.complete).flatMap(t => t.warnings.slice(0, 2).map(w => `${t.name}: ${w}`))] };
  const impacts = baseline.teams.map(t => {
    const g = t.teamId === myTeamId ? goals : unsetGoals();
    return compareTeam(baseline, after, t.teamId, categoryStandings(baseline, t.teamId, g)!, g)!;
  });
  return { moves: valid.moves, before: baseline, after, impacts, involved, blockers: [], notes };
}
