import {
  PROJECTION_STATS,
  type PlayerProjection,
  type ProjectionDataset,
  type ProjectionStats,
} from "../domain/models/projection.ts";
export interface SeasonTotals {
  readonly gamesPlayed: number;
  readonly stats: ProjectionStats;
}
/** Excluded/missing projections never become zero-valued players. */
export function projectTotals(
  projection: PlayerProjection | undefined,
  dataset: ProjectionDataset,
): SeasonTotals | null {
  if (
    !projection ||
    projection.datasetId !== dataset.id ||
    projection.status !== "valid"
  )
    return null;
  const factor = dataset.unit === "perGame" ? projection.gamesPlayed : 1;
  return {
    gamesPlayed: projection.gamesPlayed,
    stats: Object.fromEntries(
      PROJECTION_STATS.map((k) => [k, projection.stats[k] * factor]),
    ) as unknown as ProjectionStats,
  };
}
