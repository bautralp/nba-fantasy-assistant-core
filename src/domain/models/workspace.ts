import type { DraftSession } from './draft.ts';
import type { League } from './league.ts';
import type { Player } from './player.ts';
import type { PlayerProjection, ProjectionDataset } from './projection.ts';
import type { PositionEligibility, RosterEntry } from './roster.ts';
import type { Strategy } from './strategy.ts';
import type { Team } from './team.ts';

/** Serializable business data only; no computed scores or transient UI state. */
export interface WorkspaceSnapshot {
  readonly schemaVersion: 1;
  readonly manualDraftLocked?: boolean;
  readonly league: League;
  readonly teams: readonly Team[];
  readonly players: readonly Player[];
  readonly datasets: readonly ProjectionDataset[];
  readonly projections: readonly PlayerProjection[];
  readonly eligibility: readonly PositionEligibility[];
  readonly strategies: readonly Strategy[];
  readonly draftSession: DraftSession | null;
  /** Used only without a draft session. During draft, derive from picks. */
  readonly rosterEntries: readonly RosterEntry[];
}
