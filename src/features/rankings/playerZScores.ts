import { NINE_CATEGORIES, type CategoryValues } from '../../domain/models/categories.ts';
import { PROJECTION_STATS, type ProjectionStats } from '../../domain/models/projection.ts';
import { baseline, categoryValues, distribution, rawContributions } from '../../engine/categoryScores.ts';
import { selectReferencePool } from '../../engine/referencePool.ts';
import type { StatsPlayer } from './centralStats.ts';

export interface RankedStatsPlayer extends StatsPlayer {
  readonly z: CategoryValues<number>;
  readonly totalZ: number;
  readonly rank: number;
}

/** One validated period. No projections, strategy, GP scaling or display rounding. */
export function playerZScores(players: readonly StatsPlayer[]) {
  // Sort before reference selection so ties at the 130-player boundary are stable.
  const valid = [...players].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const inputs = valid.map(player => ({
    playerId: player.id,
    // The reference selector only reads stats. Its historical `totals` field is
    // deliberately supplied per-game values here; projectTotals is never called.
    totals: {
      gamesPlayed: player.gp,
      stats: Object.fromEntries(PROJECTION_STATS.map(key => [key, player.stats[key]])) as ProjectionStats,
    },
  }));
  const reference = selectReferencePool(inputs);
  const baselines = baseline(reference.map(row => row.totals.stats));
  const { means, deviations } = distribution(reference.map(row => rawContributions(row.totals.stats, baselines)));
  const rows = inputs.map((input, index) => {
    const raw = rawContributions(input.totals.stats, baselines);
    const z = categoryValues(category => (raw[category] - means[category]) / deviations[category]);
    return { ...valid[index]!, z, totalZ: NINE_CATEGORIES.reduce((sum, category) => sum + z[category], 0) };
  }).sort((a, b) => b.totalZ - a.totalZ || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    players: rows.map((row, index): RankedStatsPlayer => ({ ...row, rank: index + 1 })),
    referenceIds: reference.map(row => row.playerId),
    baselines, means, deviations,
  };
}
