import { rankDraftPool } from './poolRanking.ts';
import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import type { PlayerProjection } from '../domain/models/projection.ts';
import { createUnsetTargets, NINE_CATEGORIES, type Category } from '../domain/models/categories.ts';
import { deriveDraftRoster, snakeTeamAt } from '../domain/rules/draftRules.ts';
import { totalDraftPicks } from '../domain/rules/leagueRules.ts';
import { calculateModel, teamScores, rankTeams, categoryBalance, opponentAnalysis, recommendations, projectTotals, matchLineup } from '../engine/index.ts';

export function draftStatus(w: WorkspaceSnapshot) {
  const count = w.draftSession?.picks.length ?? 0, total = totalDraftPicks(w.league.rules);
  const completed = count >= total || w.draftSession?.status === 'completed';
  return { count, total, completed, next: completed ? null : count + 1,
    round: completed ? null : Math.floor(count / w.league.rules.teamCount) + 1,
    teamId: completed || !w.draftSession ? null : snakeTeamAt(w.draftSession.draftOrder, count, w.league.rules),
    userPosition: w.league.userTeamId && w.draftSession ? w.draftSession.draftOrder.indexOf(w.league.userTeamId) + 1 : null };
}

/** League eligibility overrides dataset eligibility, including an explicitly empty list. */
export function resolveEligibility(w: WorkspaceSnapshot) {
  const scoped = w.eligibility.filter(e => e.season === w.league.season);
  const dataset = new Map(scoped.filter(e => e.scope.kind === 'dataset' && e.scope.datasetId === w.league.activeDatasetId).map(e => [e.playerId, e.positions]));
  for (const e of scoped) if (e.scope.kind === 'league' && e.scope.leagueId === w.league.id) dataset.set(e.playerId, e.positions);
  return w.players.map(p => ({ playerId: p.id, positions: dataset.get(p.id) ?? [] }));
}
export function projectionValue(p: PlayerProjection | undefined, key: string): number | null {
  if (key === 'RANK') return p?.rank ?? null;
  if (p?.status !== 'valid') return null;
  if (key === 'GP') return p.gamesPlayed;
  if (key === 'FG%' || key === 'FT%') {
    const made = p.stats[key === 'FG%' ? 'FGM' : 'FTM'], attempts = p.stats[key === 'FG%' ? 'FGA' : 'FTA'];
    return attempts > 0 && made <= attempts ? made / attempts : null;
  }
  return p.stats[key as Exclude<Category, 'FG%' | 'FT%'>] ?? null;
}
export function selectDraftWorkspace(w: WorkspaceSnapshot) {
  const dataset = w.datasets.find(d => d.id === w.league.activeDatasetId);
  const projections = dataset ? w.projections.filter(p => p.datasetId === dataset.id) : [];
  const projectionById = new Map(projections.map(p => [p.playerId, p]));
  const roster = w.draftSession ? deriveDraftRoster(w.draftSession) : w.rosterEntries;
  const ownership = new Map(roster.map(p => [p.playerId, p.teamId]));
  const eligibility = resolveEligibility(w), positions = new Map(eligibility.map(e => [e.playerId, e.positions]));
  const model = dataset ? calculateModel(w.players, projections, dataset) : null;
  const poolRanking = rankDraftPool(w.players, projections, model, dataset);
  const scores = model ? teamScores(w.teams, roster, model) : [];
  const ranks = rankTeams(scores), teamId = w.league.userTeamId;
  const targets = w.strategies.find(s => s.teamId === teamId)?.targets ?? createUnsetTargets();
  const plan = model && teamId ? categoryBalance(scores, teamId, targets, ranks) : null;
  const opponents = model && teamId ? opponentAnalysis(scores, teamId, targets) : [];
  const topFive = model && teamId ? recommendations({ players: w.players, projections, teams: w.teams, roster, eligibility, teamId, targets, model }) : [];
  const mine = roster.filter(e => e.teamId === teamId).map(e => ({ playerId: e.playerId, positions: positions.get(e.playerId) ?? [] }));
  const lineup = matchLineup(mine);
  const totals = new Map(projections.map(p => [p.playerId, dataset ? projectTotals(p, dataset) : null]));
  const status = draftStatus(w);
  let empty = '';
  if (!dataset) empty = 'Henüz oyuncu dosyası yüklenmedi.';
  else if (!model?.usable) empty = 'Aktif veri setinde geçerli projeksiyon yok.';
  else if (status.completed) empty = 'Draft tamamlandı.';
  else if (roster.filter(p => p.teamId === teamId).length >= w.league.rules.rosterSize) empty = 'Takımınızın 13 oyunculuk kadrosu dolu.';
  else if (!teamId) empty = 'Öneriler için kendi takımınızı seçin.';
  else if (NINE_CATEGORIES.every(c => targets[c] === 'unset')) empty = 'Kategori hedefleri belirlenmedi. Strateji’den hedef seçin.';
  else if (NINE_CATEGORIES.every(c => targets[c] === 'unset' || targets[c] === 'punt')) empty = 'Bütün kategoriler unset/punt. En az bir sıralama hedefi seçin.';
  else if (!topFive.length) empty = 'Seçilmemiş geçerli aday kalmadı.';
  return { poolRanking, dataset, projections, projectionById, roster, ownership, positions, model, scores, ranks, targets, plan, opponents, topFive, lineup, totals, status, empty,
    pool: w.players.filter(p => projectionById.has(p.id) || ownership.has(p.id)) };
}
export type DraftView = ReturnType<typeof selectDraftWorkspace>;
