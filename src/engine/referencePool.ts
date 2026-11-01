import { NINE_CATEGORIES } from "../domain/models/categories.ts";
import type { PlayerId } from "../domain/models/player.ts";
import type { SeasonTotals } from "./projections.ts";
import { baseline, rawContributions, distribution } from "./categoryScores.ts";
import { MAX_PICKS } from "./modelConfig.ts";
export interface RatedProjection {
  readonly playerId: PlayerId;
  readonly totals: SeasonTotals;
}
export function selectReferencePool(valid: readonly RatedProjection[]) {
  const b = baseline(valid.map((o) => o.totals.stats));
  const rows = valid.map((o) => ({
    ...o,
    raw: rawContributions(o.totals.stats, b),
  }));
  const { means, deviations } = distribution(rows.map((o) => o.raw));
  return rows
    .map((o) => ({
      ...o,
      initial: NINE_CATEGORIES.reduce(
        (sum, c) => sum + (o.raw[c] - means[c]) / deviations[c],
        0,
      ),
    }))
    .sort((a, b) => b.initial - a.initial)
    .slice(0, Math.min(MAX_PICKS, rows.length));
}
