import type { PlayerId } from './player.ts';

export type DatasetId = string;
export type DataUnit = 'perGame' | 'totals';

export interface ProjectionDataset {
  readonly id: DatasetId;
  readonly schemaVersion: 1;
  readonly season: string;
  readonly period?: string;
  /** Preserve rejected RANK input diagnostics across session/backup reloads. */
  readonly rankInputIssue?: 'invalid';
  /** Provenance describes the source; it does not select an importer. */
  readonly source: { readonly name: string; readonly kind: 'excel' | 'csv' | 'api' | 'json' };
  /** Source period is independent of the league's season. Snapshot survives backup/restore. */
  readonly provenance?: {
    readonly sourceSeason: string;
    readonly sourceKind: 'actual' | 'projected';
    readonly generatedAt: string;
    readonly asOf: string;
    readonly gpMeaning: 'observed-last-season' | 'expected-remaining';
    readonly positionsSnapshotAt: string;
    readonly projectionMode?: 'extended';
    readonly modelVersion?: string;
    readonly sourceRevision?: string;
    readonly horizon?: 'full-season' | 'remaining-season';
  };
  /** ISO 8601 timestamp supplied by the caller. */
  readonly importedAt: string;
  readonly unit: DataUnit;
}

export const PROJECTION_STATS = ['FGM', 'FGA', 'FTM', 'FTA', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO'] as const;
export type ProjectionStats = Readonly<Record<typeof PROJECTION_STATS[number], number>>;

interface ProjectionIdentity {
  readonly playerId: PlayerId;
  readonly datasetId: DatasetId;
  readonly rank?: number;
  /** Optional presentation only. Engine math never reads these source values. */
  readonly presentation?: { readonly team?: string; readonly mpg?: number; readonly modelLabel?: string };
}

/** Invalid rows retain identity and draft membership without entering analysis. */
export type PlayerProjection = ProjectionIdentity & (
  | { readonly status: 'valid'; readonly gamesPlayed: number; readonly stats: ProjectionStats }
  | { readonly status: 'excluded'; readonly reasons: readonly string[] }
);
