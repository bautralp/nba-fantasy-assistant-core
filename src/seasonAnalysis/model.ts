import type { Category } from '../domain/models/categories.ts';
import type { ProjectionStats } from '../domain/models/projection.ts';
import type { PublicLeague, LeagueTeam } from '../features/season/model.ts';

export const CATEGORIES: readonly Category[] = ['FG%', 'FT%', '3PM', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PTS'];
export const MODEL_VERSION = 'season-9cat/1.1';
export interface AnalysisProjection {
  espnId: number; nbaTeamId: number | null; teamState?: 'assigned' | 'unassigned' | 'unknown'; kind: 'ROS' | 'Actual';
  unit: 'perGame' | 'remainingTotal'; stats: ProjectionStats | null;
  expectedGames: number | null; teamRemaining: number | null; warnings: string[];
}
/** Dates are NBA calendar days (America/New_York), not browser-local dates. */
export interface NbaSchedule {
  schemaVersion: 1; seasonId: number; asOf: string; through: string; retrievedAt: string;
  source: { url: string; sha256: string }; scope: 'observed-regular-season';
  games: { id: string; date: string; teamIds: [number, number] }[];
}
export interface AnalysisInput {
  league: PublicLeague; projections: readonly AnalysisProjection[]; schedule: NbaSchedule | null;
  datasetRevision: string; dataUpdatedAt: string; asOf: string;
  /** Independent immutable roster variants; source ESPN snapshot is never written. */
  teams?: readonly LeagueTeam[];
  lineupPolicy: 'daily-max-games';
}
export interface Coverage {
  rosterPlayers: number; irPlayers: number; matchedPlayers: number; includedPlayers: number;
  scheduledGames: number; selectedGames: number; expectedGames: number;
}
export interface CategoryResult {
  teamId: number; name: string; projectedValue: number | null; powerScore: number | null; rank: number | null;
  leaderGap: number | null; aboveGap: number | null; belowGap: number | null;
  coverage: Coverage; warnings: string[];
}
export interface TeamAnalysis {
  teamId: number; name: string; coverage: Coverage; warnings: string[];
  /** Diagnostic subset only. Missing players never imply zero team contribution. */
  partialTotals: ProjectionStats; complete: boolean;
  contributions: { espnId: number; scheduledGames: number; selectedGames: number; expectedGames: number }[];
}
export interface LeagueAnalysis {
  status: 'ready' | 'blocked'; modelVersion: string; projectionKind: 'ROS';
  sourceRevision: string; datasetRevision: string; scheduleRevision: string | null; revision: string;
  asOf: string; dataUpdatedAt: string; horizon: { fromExclusive: string; through: string | null };
  lineupPolicy: 'daily-max-games'; scope: string; warnings: string[];
  coverage: { totalTeams: number; completeTeams: number; rankedCategories: number };
  teams: TeamAnalysis[]; rankings: Record<Category, CategoryResult[]>;
}
