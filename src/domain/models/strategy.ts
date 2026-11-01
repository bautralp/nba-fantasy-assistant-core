import type { CategoryTargets } from './categories.ts';
import type { LeagueId } from './league.ts';
import type { TeamId } from './team.ts';

export interface Strategy {
  readonly leagueId: LeagueId;
  readonly teamId: TeamId;
  readonly targets: CategoryTargets;
}
