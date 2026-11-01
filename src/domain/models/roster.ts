import type { LeagueId } from './league.ts';
import type { PlayerId } from './player.ts';
import type { DatasetId } from './projection.ts';
import type { TeamId } from './team.ts';

/** G and F are general eligibility tokens, never expanded to specific positions. */
export const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'] as const;
export type Position = typeof POSITIONS[number];
export type RosterSlot = Position | 'UTIL' | 'BENCH';

/** No global eligibility on Player; an empty positions array means unknown. */
export interface PositionEligibility {
  readonly playerId: PlayerId;
  readonly season: string;
  readonly scope:
    | { readonly kind: 'league'; readonly leagueId: LeagueId }
    | { readonly kind: 'dataset'; readonly datasetId: DatasetId };
  readonly positions: readonly Position[];
}

export interface RosterEntry {
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  /** Optional preference, not a guaranteed lineup placement. */
  readonly preferredSlot?: RosterSlot;
}
