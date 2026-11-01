import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import { createUnsetTargets } from '../domain/models/categories.ts';
import { settingsFromWorkspace, validateLeagueSettings } from './leagueSetup.ts';

/** Derived from existing business data, including native v1 and migrated v3 records. */
export function selectPreparation(workspace: WorkspaceSnapshot | null) {
  const league = !!workspace && Object.keys(validateLeagueSettings(settingsFromWorkspace(workspace))).length === 0;
  const targets = workspace?.strategies.find(s => s.teamId === workspace.league.userTeamId)?.targets;
  const strategy = !!targets && Object.values(targets).some(t => t !== 'unset' && t !== 'punt');
  const pool = !!workspace?.datasets.some(d => d.id === workspace.league.activeDatasetId);
  const hasDraft = !!(workspace?.draftSession?.picks.length || workspace?.rosterEntries.length);
  return { league, strategy, pool, hasDraft, ready: league && strategy && pool, canOpen: hasDraft || league && strategy && pool };
}
export type PreparationReset = 'strategy' | 'pool';
/** Pure command; WorkspaceStore.accept remains the central validation boundary. */
export function resetPreparation(workspace: WorkspaceSnapshot, kind: PreparationReset): WorkspaceSnapshot {
  if (kind === 'pool') return { ...workspace, league: { ...workspace.league, activeDatasetId: null } };
  const teamId = workspace.league.userTeamId;
  if (!teamId) throw new Error('Önce kendi takımınızı seçin.');
  return { ...workspace, strategies: workspace.strategies.map(s => s.teamId === teamId ? { ...s, targets: createUnsetTargets() } : s) };
}
