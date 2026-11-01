import { createUnsetTargets } from '../models/categories.ts';
import type { WorkspaceSnapshot } from '../models/workspace.ts';
import { INITIAL_LEAGUE_RULES } from './leagueRules.ts';

/** IDs come from the caller; the domain never derives identity from a name. */
export function createInitialWorkspace(input: {
  readonly leagueId: string;
  readonly season: string;
  readonly teamIds: readonly string[];
  readonly draftSessionId: string;
}): WorkspaceSnapshot {
  if (!input.leagueId.trim() || !input.draftSessionId.trim() || !input.season.trim()
    || input.teamIds.length !== INITIAL_LEAGUE_RULES.teamCount
    || new Set(input.teamIds).size !== input.teamIds.length || input.teamIds.some(id => !id.trim())) {
    throw new Error('Initial workspace requires stable IDs, season and ten distinct teams');
  }
  return {
    schemaVersion: 1,
    league: { id: input.leagueId, name: '', season: input.season, rules: INITIAL_LEAGUE_RULES, activeDatasetId: null, userTeamId: null },
    teams: input.teamIds.map(id => ({ id, leagueId: input.leagueId, name: '' })),
    players: [], datasets: [], projections: [], eligibility: [], rosterEntries: [],
    strategies: input.teamIds.map(teamId => ({ leagueId: input.leagueId, teamId, targets: createUnsetTargets() })),
    draftSession: { id: input.draftSessionId, leagueId: input.leagueId, draftOrder: [...input.teamIds], picks: [], status: 'setup' },
  };
}
