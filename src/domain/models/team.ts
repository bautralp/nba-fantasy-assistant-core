import type { LeagueId } from './league.ts';

export type TeamId = string;
export interface Team {
  readonly id: TeamId;
  readonly leagueId: LeagueId;
  readonly name: string;
}
