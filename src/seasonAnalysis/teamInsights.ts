import type { Category } from '../domain/models/categories.ts';
import type { LeagueTeam } from '../features/season/model.ts';
import type { LeagueEvaluator } from './analyzeLeague.ts';
import { CATEGORIES, type AnalysisProjection, type LeagueAnalysis } from './model.ts';
import { GOAL_RANK, type SeasonCategoryGoals } from './strategy.ts';

/** Strategy layer on top of the shared 9CAT engine. It never changes projected values:
 * goals only weight how much a change in each category matters to recommendations. */
export const STRATEGY_MODEL_VERSION = 'season-strategy/1';
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
export const direction = (c: Category) => c === 'TO' ? -1 : 1;

export type GoalStatus = 'met' | 'missed' | 'punt' | 'unset';
export type WeightReason = 'punt' | 'unset' | 'close' | 'far' | 'edge' | 'safe';
/** Weights are fixed and documented; Δz is the change in league standard deviations. */
export const STRATEGY_WEIGHTS: Readonly<Record<WeightReason, number>> = { punt: 0, unset: 1, close: 2, far: 1.5, edge: 1, safe: 0.5 };
export const CLOSE_GAP_SD = 1, SAFE_CUSHION_SD = 0.5;

export interface CategoryStanding {
  category: Category; rank: number; teams: number; value: number; sd: number;
  goal: SeasonCategoryGoals[Category]; targetRank: number | null; status: GoalStatus;
  /** Positive distance in category units (percentage points for FG%/FT%, fewer TO for TO). */
  gap: number | null; cushion: number | null;
  /** FG%/FT% only: makes needed at the team's current attempt volume to close the gap. */
  makesNeeded: number | null; attempts: number | null;
  aboveGap: number | null; belowGap: number | null;
  weight: number; weightReason: WeightReason;
}

/** Sample SD of team values, matching the engine's power-score convention. */
export function categorySd(analysis: LeagueAnalysis, c: Category): number | null {
  const v = analysis.rankings[c].map(r => r.projectedValue);
  if (v.length < 2 || v.some(x => x === null)) return null;
  const mean = (v as number[]).reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt((v as number[]).reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
}
export const isReady = (a: LeagueAnalysis | null): a is LeagueAnalysis =>
  !!a && a.status === 'ready' && CATEGORIES.every(c => a.rankings[c].every(r => r.rank !== null && r.projectedValue !== null && Number.isFinite(r.projectedValue)));

export function categoryStandings(analysis: LeagueAnalysis, teamId: number, goals: SeasonCategoryGoals): CategoryStanding[] | null {
  if (!isReady(analysis)) return null;
  const team = analysis.teams.find(t => t.teamId === teamId);
  if (!team) return null;
  return CATEGORIES.map(category => {
    const rows = analysis.rankings[category], own = rows.find(r => r.teamId === teamId)!, d = direction(category);
    const sd = categorySd(analysis, category)!, value = own.projectedValue!, goal = goals[category];
    const others = rows.filter(r => r.teamId !== teamId).map(r => r.projectedValue!).sort((a, b) => d * (b - a));
    const targetRank = GOAL_RANK[goal] ?? null;
    let status: GoalStatus = goal === 'punt' ? 'punt' : goal === 'unset' ? 'unset' : 'met', gap: number | null = null, cushion: number | null = null;
    if (targetRank !== null) {
      // Rank <= k exactly when no more than k-1 other teams are strictly better, i.e.
      // the value is at least the k-th best other team's value (ties share the rank).
      const threshold = others[targetRank - 1];
      if (threshold === undefined) { status = 'met'; cushion = null; }
      else if (near(value, threshold) || d * (value - threshold) > 0) { status = 'met'; cushion = near(value, threshold) ? 0 : d * (value - threshold); }
      else { status = 'missed'; gap = d * (threshold - value); }
    }
    const pct = category === 'FG%' || category === 'FT%';
    const attempts = pct ? team.partialTotals[category === 'FG%' ? 'FGA' : 'FTA'] : null;
    const weightReason: WeightReason = status === 'punt' ? 'punt' : status === 'unset' ? 'unset'
      : status === 'missed' ? (sd === 0 || gap! <= CLOSE_GAP_SD * sd ? 'close' : 'far')
      : cushion === null || (sd > 0 && cushion >= SAFE_CUSHION_SD * sd) ? 'safe' : 'edge';
    return { category, rank: own.rank!, teams: rows.length, value, sd, goal, targetRank, status, gap, cushion,
      makesNeeded: pct && gap !== null && attempts ? gap / 100 * attempts : null, attempts,
      aboveGap: own.aboveGap, belowGap: own.belowGap, weight: STRATEGY_WEIGHTS[weightReason], weightReason };
  });
}

export interface CategoryImpact {
  category: Category; before: number; after: number; delta: number; deltaZ: number;
  beforeRank: number; afterRank: number; rankGain: number; weight: number;
  /** True when the user chose a rank goal (İlk 1/3/5/7) for this category. */
  targeted: boolean;
}
export interface TeamImpact {
  teamId: number; categories: CategoryImpact[];
  /** Σ weight × Δz over the nine categories. Punt contributes 0 but its values stay visible. */
  strategyScore: number; balanceScore: number; goalsMetBefore: number; goalsMetAfter: number;
}
/** Same-snapshot before/after comparison; refuses analyses from different sources. */
export function compareTeam(before: LeagueAnalysis, after: LeagueAnalysis, teamId: number, standings: readonly CategoryStanding[], goals: SeasonCategoryGoals): TeamImpact | null {
  if (!isReady(before) || !isReady(after) || before.sourceRevision !== after.sourceRevision || before.datasetRevision !== after.datasetRevision || before.scheduleRevision !== after.scheduleRevision) return null;
  const categories = standings.map(s => {
    const b = before.rankings[s.category].find(r => r.teamId === teamId), a = after.rankings[s.category].find(r => r.teamId === teamId);
    if (!b || !a) return null;
    const delta = a.projectedValue! - b.projectedValue!, deltaZ = s.sd > 0 ? direction(s.category) * delta / s.sd : 0;
    return { category: s.category, before: b.projectedValue!, after: a.projectedValue!, delta, deltaZ, beforeRank: b.rank!, afterRank: a.rank!, rankGain: b.rank! - a.rank!, weight: s.weight, targeted: s.targetRank !== null };
  });
  if (categories.some(c => c === null)) return null;
  const rows = categories as CategoryImpact[];
  const met = (a: LeagueAnalysis) => rows.filter(c => GOAL_RANK[goals[c.category]] !== undefined && a.rankings[c.category].find(r => r.teamId === teamId)!.rank! <= GOAL_RANK[goals[c.category]]!).length;
  return { teamId, categories: rows, strategyScore: rows.reduce((s, c) => s + c.weight * c.deltaZ, 0), balanceScore: rows.reduce((s, c) => s + c.deltaZ, 0), goalsMetBefore: met(before), goalsMetAfter: met(after) };
}

export interface PlayerContribution {
  espnPlayerId: number; name: string; placement: 'active' | 'bench' | 'ir' | 'unknown';
  /** Lineup-usable games after daily slot matching vs. the projection's expected games. */
  usableGames: number | null; projectedGames: number | null;
  /** Team with the player minus team without the player (the bench may fill freed slots). */
  impact: TeamImpact | null;
  /** Player's own per-game shooting, for volume-weighted FG%/FT% explanations. */
  shooting: { FGM: number; FGA: number; FTM: number; FTA: number } | null;
}
export function rosterContributions(evaluator: LeagueEvaluator, teams: readonly LeagueTeam[], teamId: number, goals: SeasonCategoryGoals, projections: readonly AnalysisProjection[]): { baseline: LeagueAnalysis; standings: CategoryStanding[]; players: PlayerContribution[] } | null {
  const baseline = evaluator.evaluate(teams), standings = categoryStandings(baseline, teamId, goals);
  const team = teams.find(t => t.espnTeamId === teamId);
  if (!standings || !team?.roster) return null;
  const used = new Map(baseline.teams.find(t => t.teamId === teamId)!.contributions.map(c => [c.espnId, c]));
  const projection = new Map(projections.map(p => [p.espnId, p]));
  const players = team.roster.map(p => {
    const row = projection.get(p.espnPlayerId), use = used.get(p.espnPlayerId);
    let impact: TeamImpact | null = null;
    if (p.placement !== 'ir') {
      const without = evaluator.evaluate(teams.map(t => t.espnTeamId === teamId ? { ...t, roster: t.roster!.filter(x => x.espnPlayerId !== p.espnPlayerId) } : t));
      impact = compareTeam(without, baseline, teamId, standings, goals);
    }
    const s = row?.unit === 'perGame' ? row.stats : null;
    return { espnPlayerId: p.espnPlayerId, name: p.name, placement: p.placement, usableGames: use?.expectedGames ?? null,
      projectedGames: row?.expectedGames ?? null, impact, shooting: s ? { FGM: s.FGM, FGA: s.FGA, FTM: s.FTM, FTA: s.FTA } : null };
  });
  players.sort((a, b) => (b.impact?.strategyScore ?? -Infinity) - (a.impact?.strategyScore ?? -Infinity) || a.espnPlayerId - b.espnPlayerId);
  return { baseline, standings, players };
}
