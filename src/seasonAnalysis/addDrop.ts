import type { LeaguePlayer, LeagueTeam } from '../features/season/model.ts';
import type { WaiverPlayer } from '../infrastructure/espn/waiverPool.ts';
import type { LeagueEvaluator } from './analyzeLeague.ts';
import type { AnalysisProjection, LeagueAnalysis } from './model.ts';
import { capacityIssues, rebuildTeam, rosterCapacity } from './rosterMoves.ts';
import { categoryStandings, compareTeam, isReady, type CategoryStanding, type TeamImpact } from './teamInsights.ts';
import type { SeasonCategoryGoals } from './strategy.ts';

/** Simulation only: nothing is sent to ESPN. Before and after use the same evaluator
 * (same league rules, projections and schedule) and every team is re-ranked. */
export interface AddDropAnalysis {
  baseRevision: string; addId: number; dropId: number;
  blockers: string[]; notes: string[];
  before: LeagueAnalysis; after: LeagueAnalysis | null; impact: TeamImpact | null;
}
export const asLeaguePlayer = (p: WaiverPlayer): LeaguePlayer => ({ espnPlayerId: p.espnPlayerId, name: p.name, proTeamId: p.proTeamId, eligibleSlotIds: p.eligibleSlotIds, lineupSlotId: 12, primaryPosition: p.primaryPosition, displayPositions: p.displayPositions, placement: 'bench' });

/** Reasons a pool player cannot be evaluated with the shared projection. */
export function candidateIssue(p: WaiverPlayer, projection: AnalysisProjection | undefined, activeSlots: readonly number[]): string | null {
  if (!projection) return 'Kalan sezon tahmini yok.';
  if (projection.kind !== 'ROS' || projection.expectedGames === null || projection.teamRemaining === null) return 'Kalan maç beklentisi bilinmiyor.';
  if (projection.nbaTeamId !== p.proTeamId) return 'NBA takımı tahmin kaynağıyla uyuşmuyor.';
  if (projection.expectedGames > 0 && !projection.stats) return 'Kalan sezon istatistiği yok.';
  if (!p.eligibleSlotIds.some(s => activeSlots.includes(s))) return 'Ligin aktif slotlarına uygun pozisyonu yok.';
  return null;
}
export function simulateAddDrop({ evaluator, teams, baseline, slots, myTeamId, add, dropId, goals, projection }: {
  evaluator: LeagueEvaluator; teams: readonly LeagueTeam[]; baseline: LeagueAnalysis; slots: readonly { slotId: number; count: number }[];
  myTeamId: number; add: WaiverPlayer; dropId: number; goals: SeasonCategoryGoals; projection: AnalysisProjection | undefined;
}): AddDropAnalysis {
  const blockers: string[] = [], notes: string[] = [], mine = teams.find(t => t.espnTeamId === myTeamId);
  const owned = teams.find(t => t.roster?.some(p => p.espnPlayerId === add.espnPlayerId));
  const drop = mine?.roster?.find(p => p.espnPlayerId === dropId);
  if (!mine?.roster) blockers.push('Takım kadrosu bulunamadı.');
  if (owned) blockers.push(`${add.name} artık ${owned.name} kadrosunda; havuzda değil.`);
  if (!drop) blockers.push('Bırakılacak oyuncu kadronda değil.');
  if (add.espnPlayerId === dropId) blockers.push('Aynı oyuncu hem eklenip hem bırakılamaz.');
  const issue = candidateIssue(add, projection, rosterCapacity(slots).active);
  if (issue) blockers.push(`${add.name}: ${issue}`);
  if (!isReady(baseline)) blockers.push('Mevcut lig analizi hazır değil.');
  const base = { baseRevision: evaluator.baseRevision, addId: add.espnPlayerId, dropId, before: baseline };
  if (blockers.length) return { ...base, blockers, notes, after: null, impact: null };
  if (add.status === 'WAIVERS') notes.push(add.waiverProcessDate ? `${add.name} waiver'da: ESPN talebi ${new Date(add.waiverProcessDate).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' })} tarihinde işler; hak sırası ve sonucu bilinmiyor.` : `${add.name} waiver'da; işlem tarihi ve hak sırası bilinmiyor.`);
  if (add.injuryStatus && add.injuryStatus !== 'ACTIVE') notes.push(`${add.name} sakatlık durumu: ${add.injuryStatus}. Dönüş tarihi modellenmez.`);
  if (drop!.placement === 'ir') notes.push(`${drop!.name} IR'de; bırakmak normal kadro yeri açmaz.`);
  const next = rebuildTeam(mine!, new Set([dropId]), [asLeaguePlayer(add)]);
  const capacity = capacityIssues(next, slots);
  if (capacity.length) return { ...base, blockers: capacity, notes, after: null, impact: null };
  const variant = teams.map(t => t.espnTeamId === myTeamId ? next : t);
  const after = evaluator.evaluate(variant);
  const standings: CategoryStanding[] | null = categoryStandings(baseline, myTeamId, goals);
  const impact = standings ? compareTeam(baseline, after, myTeamId, standings, goals) : null;
  if (!impact) return { ...base, blockers: ['Değişiklik sonrası lig analizi hesaplanamadı (eksik kapsam).'], notes, after, impact: null };
  return { ...base, blockers, notes, after, impact };
}
/** Best drop for one candidate: highest strategy score, ties broken by lower ESPN ID. */
export function bestDrop(args: Omit<Parameters<typeof simulateAddDrop>[0], 'dropId'>, candidates: readonly number[]): AddDropAnalysis | null {
  let best: AddDropAnalysis | null = null;
  for (const dropId of candidates) {
    const r = simulateAddDrop({ ...args, dropId });
    if (!r.impact) continue;
    if (!best || r.impact.strategyScore > best.impact!.strategyScore + 1e-12 || Math.abs(r.impact.strategyScore - best.impact!.strategyScore) <= 1e-12 && dropId < best.dropId) best = r;
  }
  return best;
}
