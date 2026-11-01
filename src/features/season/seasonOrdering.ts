import type { LeaguePlayer, LeagueTeam, PublicLeague } from './model.ts';
import { BASKETBALL_POSITIONS } from './positions.ts';
type Matchup = NonNullable<PublicLeague['matchups']>[number];
/** Stable partition creates a view; ownership, schedule and roster arrays remain untouched. */
function first<T>(items: readonly T[], matches: (item: T) => boolean): T[] {
  return [...items.filter(matches), ...items.filter(item => !matches(item))];
}
export const prioritizeMatchups = (items: readonly Matchup[], teamId: number) => first(items, m => m.home?.teamId === teamId || m.away?.teamId === teamId);
export const prioritizeTeams = (teams: readonly LeagueTeam[], teamId: number) => first(teams, t => t.espnTeamId === teamId);
const names = new Intl.Collator('tr', { sensitivity: 'base', numeric: true });
export const compareNames = (a: string, b: string) => names.compare(a, b);
function group(player: LeaguePlayer) {
  if (player.displayPositions.some(p => p === 'PG' || p === 'SG')) return 0;
  if (player.displayPositions.some(p => p === 'SF' || p === 'PF')) return 1;
  return player.displayPositions.includes('C') ? 2 : 3;
}
function primaryOrder(player: LeaguePlayer) {
  const position = player.primaryPosition ?? player.displayPositions[0];
  return position ? BASKETBALL_POSITIONS.indexOf(position) : BASKETBALL_POSITIONS.length;
}
export function orderRoster(players: readonly LeaguePlayer[]) {
  return [...players].sort((a, b) => group(a) - group(b) || primaryOrder(a) - primaryOrder(b) || compareNames(a.name, b.name) || a.espnPlayerId - b.espnPlayerId);
}
