import type { Player, PlayerId } from "../domain/models/player.ts";
import type {
  PlayerProjection,
  ProjectionDataset,
} from "../domain/models/projection.ts";
import type { CategoryValues } from "../domain/models/categories.ts";
import { projectTotals } from "./projections.ts";
import {
  baseline,
  rawContributions,
  distribution,
  categoryValues,
  type Baselines,
} from "./categoryScores.ts";
import { selectReferencePool, type RatedProjection } from "./referencePool.ts";
export interface CalculationModel {
  readonly valid: readonly RatedProjection[];
  readonly baselines: Baselines | null;
  readonly means?: CategoryValues<number>;
  readonly deviations?: CategoryValues<number>;
  readonly z: ReadonlyMap<PlayerId, CategoryValues<number>>;
  readonly usable: boolean;
  readonly referenceCount?: number;
  readonly referenceIds: readonly PlayerId[];
}
export function calculateModel(
  players: readonly Player[],
  projections: readonly PlayerProjection[],
  dataset: ProjectionDataset,
): CalculationModel {
  const byId = new Map(
    projections
      .filter((p) => p.datasetId === dataset.id)
      .map((p) => [p.playerId, p]),
  );
  const valid: RatedProjection[] = [];
  for (const p of players) {
    const totals = projectTotals(byId.get(p.id), dataset);
    if (totals) valid.push({ playerId: p.id, totals });
  }
  if (!valid.length)
    return {
      valid,
      baselines: null,
      z: new Map(),
      usable: false,
      referenceIds: [],
    };
  const ref = selectReferencePool(valid),
    b = baseline(ref.map((o) => o.totals.stats));
  const { means, deviations } = distribution(
    ref.map((o) => rawContributions(o.totals.stats, b)),
  );
  const z = new Map(
    valid.map((o) => {
      const r = rawContributions(o.totals.stats, b);
      return [
        o.playerId,
        categoryValues((c) => (r[c] - means[c]) / deviations[c]),
      ] as const;
    }),
  );
  return {
    valid,
    baselines: b,
    means,
    deviations,
    z,
    usable: true,
    referenceCount: ref.length,
    referenceIds: ref.map((o) => o.playerId),
  };
}
