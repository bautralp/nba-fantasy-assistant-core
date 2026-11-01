import type { DraftPick, DraftSession } from '../models/draft.ts';
import type { LeagueRules } from '../models/league.ts';
import type { RosterEntry } from '../models/roster.ts';
import type { TeamId } from '../models/team.ts';
import { totalDraftPicks } from './leagueRules.ts';

/** Zero-based selection index; no next team once the draft is full. */
export function snakeTeamAt(order: readonly TeamId[], pickIndex: number, rules: LeagueRules): TeamId | null {
  if (order.length !== rules.teamCount || !Number.isInteger(pickIndex) || pickIndex < 0 || pickIndex >= totalDraftPicks(rules)) return null;
  const round = Math.floor(pickIndex / rules.teamCount);
  const position = pickIndex % rules.teamCount;
  return order[round % 2 === 0 ? position : rules.teamCount - 1 - position] ?? null;
}

export function deriveDraftRoster(session: DraftSession): readonly RosterEntry[] {
  return session.picks.map(({ playerId, teamId }) => ({ playerId, teamId }));
}

/** Record the actual turn now; callers cannot reuse another pick's historical index. */
export function appendDraftPick(session: DraftSession, assignment: Pick<DraftPick, 'playerId' | 'teamId' | 'outOfTurnConfirmed'>, rules: LeagueRules): DraftSession {
  const index = session.picks.length;
  if (session.status === 'completed' || index >= totalDraftPicks(rules)) throw new Error('Draft is full');
  if (!session.draftOrder.includes(assignment.teamId)) throw new Error('Unknown draft team');
  if (session.picks.some(pick => pick.playerId === assignment.playerId)) throw new Error('Player already selected');
  if (session.picks.filter(pick => pick.teamId === assignment.teamId).length >= rules.rosterSize) throw new Error('Team is full');
  if (assignment.teamId !== snakeTeamAt(session.draftOrder, index, rules) && assignment.outOfTurnConfirmed !== true) throw new Error('Out-of-turn assignment requires confirmation');
  const pick: DraftPick = {
    playerId: assignment.playerId, teamId: assignment.teamId, selectionIndex: index,
    ...(assignment.outOfTurnConfirmed === true ? { outOfTurnConfirmed: true } : {}),
  };
  return { ...session, picks: [...session.picks, pick], status: index + 1 === totalDraftPicks(rules) ? 'completed' : 'inProgress' };
}

/** Capture missing historical indices before deleting. Ownership and consent stay intact. */
export function removeDraftPick(session: DraftSession, playerId: DraftPick['playerId']): DraftSession {
  if (!session.picks.some(pick => pick.playerId === playerId)) throw new Error('Player is not selected');
  const picks = session.picks
    .map((pick, index) => ({ ...pick, selectionIndex: pick.selectionIndex ?? index }))
    .filter(pick => pick.playerId !== playerId);
  return { ...session, picks, status: picks.length === 0 ? 'setup' : 'inProgress' };
}

/** Return a new session; the first pick locks the order. */
export function changeDraftOrder(session: DraftSession, order: readonly TeamId[]): DraftSession {
  if (session.status !== 'setup' || session.picks.length > 0) throw new Error('Draft order is locked');
  if (order.length !== session.draftOrder.length || new Set(order).size !== order.length
    || order.some(id => !session.draftOrder.includes(id))) throw new Error('Draft order must be a team permutation');
  return { ...session, draftOrder: [...order] };
}
