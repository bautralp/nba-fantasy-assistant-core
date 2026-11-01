import type { LeagueId } from './league.ts';
import type { PlayerId } from './player.ts';
import type { TeamId } from './team.ts';

export interface DraftPick {
  readonly playerId: PlayerId;
  readonly teamId: TeamId;
  /** Pick count when assigned, preserved across deletions; not a current array index.
   * Omitted on unedited sessions means the current array index. New picks record it.
   */
  readonly selectionIndex?: number;
  /** Explicit domain evidence for an intentionally out-of-turn assignment. */
  readonly outOfTurnConfirmed?: boolean;
}

export interface DraftSession {
  readonly id: string;
  readonly leagueId: LeagueId;
  /** First-round order; array position is never a team identity. */
  readonly draftOrder: readonly TeamId[];
  /** Chronological order is authoritative. No redundant pick counter. */
  readonly picks: readonly DraftPick[];
  readonly status: 'setup' | 'inProgress' | 'completed';
}
