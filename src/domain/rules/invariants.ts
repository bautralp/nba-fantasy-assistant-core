import { CATEGORY_TARGETS, NINE_CATEGORIES } from '../models/categories.ts';
import { PROJECTION_STATS } from '../models/projection.ts';
import { POSITIONS } from '../models/roster.ts';
import type { WorkspaceSnapshot } from '../models/workspace.ts';
import { deriveDraftRoster, snakeTeamAt } from './draftRules.ts';
import { isSupportedLeagueRules, totalDraftPicks } from './leagueRules.ts';

export type IntegrityCode = 'unsupported-schema' | 'unsupported-rules' | 'invalid-value'
  | 'duplicate-id' | 'invalid-reference' | 'duplicate-player' | 'team-capacity'
  | 'draft-order' | 'draft-status' | 'out-of-turn' | 'roster-source';
export interface IntegrityIssue {
  readonly code: IntegrityCode;
  readonly path: string;
}

/** Checks typed domain data. Raw Excel/API/JSON parsing belongs to future adapters. */
export function validateWorkspace(snapshot: WorkspaceSnapshot): readonly IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const add = (code: IntegrityCode, path: string) => { issues.push({ code, path }); };
  const reference = (valid: boolean, path: string) => { if (!valid) add('invalid-reference', path); };
  const unique = (keys: readonly string[], path: string) => {
    const seen = new Set<string>();
    keys.forEach((key, index) => {
      if (!key.trim()) add('invalid-value', `${path}[${index}]`);
      if (seen.has(key)) add('duplicate-id', `${path}[${index}]`);
      seen.add(key);
    });
  };
  const { league, teams, players, datasets, projections, strategies, eligibility, draftSession } = snapshot;
  if (snapshot.schemaVersion !== 1) add('unsupported-schema', 'schemaVersion');
  if (!league.id.trim()) add('invalid-value', 'league.id');
  if (!isSupportedLeagueRules(league.rules)) add('unsupported-rules', 'league.rules');
  unique(teams.map(team => team.id), 'teams');
  unique(players.map(player => player.id), 'players');
  unique(datasets.map(dataset => dataset.id), 'datasets');
  const teamIds = new Set(teams.map(team => team.id));
  const playerIds = new Set(players.map(player => player.id));
  const datasetById = new Map(datasets.map(dataset => [dataset.id, dataset]));
  if (teams.length !== league.rules.teamCount) add('invalid-value', 'teams.length');
  teams.forEach((team, index) => reference(team.leagueId === league.id, `teams[${index}].leagueId`));
  players.forEach((player, index) => {
    if (!player.name.trim()) add('invalid-value', `players[${index}].name`);
  });
  reference(league.userTeamId === null || teamIds.has(league.userTeamId), 'league.userTeamId');
  reference(league.activeDatasetId === null || datasetById.has(league.activeDatasetId), 'league.activeDatasetId');
  if (league.activeDatasetId !== null) reference(datasetById.get(league.activeDatasetId)?.season === league.season, 'league.activeDatasetId.season');
  datasets.forEach((dataset, index) => {
    if (dataset.provenance) {
      const p = dataset.provenance;
      if (p.projectionMode !== undefined && (p.projectionMode !== 'extended' || typeof p.modelVersion !== 'string' || !p.modelVersion || typeof p.sourceRevision !== 'string' || !p.sourceRevision || !['full-season','remaining-season'].includes(p.horizon ?? '') || p.sourceKind !== 'projected')) add('invalid-value', `datasets[${index}].provenance.projectionMode`);
      if (dataset.source.kind !== 'api' || dataset.season !== '2026-27'
        || !Number.isFinite(Date.parse(p.generatedAt)) || !Number.isFinite(Date.parse(p.positionsSnapshotAt))
        || !/^\d{4}-\d{2}-\d{2}$/.test(p.asOf)
        || !(p.sourceKind === 'actual' && p.sourceSeason === '2025-26' && p.gpMeaning === 'observed-last-season'
          || p.sourceKind === 'projected' && p.sourceSeason === '2026-27' && p.gpMeaning === 'expected-remaining')) add('invalid-value', `datasets[${index}].provenance`);
    }
    if (dataset.rankInputIssue !== undefined && dataset.rankInputIssue !== 'invalid') add('invalid-value', `datasets[${index}].rankInputIssue`);
    if (dataset.schemaVersion !== 1) add('unsupported-schema', `datasets[${index}].schemaVersion`);
    if (!['perGame', 'totals'].includes(dataset.unit) || !Number.isFinite(Date.parse(dataset.importedAt))
      || !dataset.season.trim() || !dataset.source.name.trim() || !['excel', 'csv', 'api', 'json'].includes(dataset.source.kind)) add('invalid-value', `datasets[${index}]`);
  });
  unique(projections.map(row => JSON.stringify([row.datasetId, row.playerId])), 'projections');
  projections.forEach((projection, index) => {
    const path = `projections[${index}]`;
    reference(playerIds.has(projection.playerId), `${path}.playerId`);
    reference(datasetById.has(projection.datasetId), `${path}.datasetId`);
    if (projection.rank !== undefined && (!Number.isInteger(projection.rank) || projection.rank <= 0)) add('invalid-value', `${path}.rank`);
    if (projection.presentation && (projection.presentation.team !== undefined && !projection.presentation.team.trim()
      || projection.presentation.modelLabel !== undefined && (typeof projection.presentation.modelLabel !== 'string' || !projection.presentation.modelLabel.trim())
      || projection.presentation.mpg !== undefined && (!Number.isFinite(projection.presentation.mpg) || projection.presentation.mpg < 0))) add('invalid-value', `${path}.presentation`);
    if (projection.status === 'valid') {
      if (!Number.isFinite(projection.gamesPlayed) || projection.gamesPlayed <= 0) add('invalid-value', `${path}.gamesPlayed`);
      if (PROJECTION_STATS.some(stat => !Number.isFinite(projection.stats[stat]) || projection.stats[stat] < 0)
        || projection.stats.FGM > projection.stats.FGA || projection.stats.FTM > projection.stats.FTA) add('invalid-value', `${path}.stats`);
    } else if (projection.status !== 'excluded' || projection.reasons.length === 0 || projection.reasons.some(reason => !reason.trim())) {
      add('invalid-value', `${path}.status`);
    }
  });
  unique(eligibility.map(row => JSON.stringify([row.playerId, row.season, row.scope.kind,
    row.scope.kind === 'league' ? row.scope.leagueId : row.scope.datasetId])), 'eligibility');
  eligibility.forEach((row, index) => {
    const path = `eligibility[${index}]`;
    reference(playerIds.has(row.playerId), `${path}.playerId`);
    reference(row.scope.kind === 'league'
      ? row.scope.leagueId === league.id && row.season === league.season
      : datasetById.get(row.scope.datasetId)?.season === row.season, `${path}.scope`);
    if (new Set(row.positions).size !== row.positions.length || row.positions.some(position => !POSITIONS.includes(position))) add('invalid-value', `${path}.positions`);
  });
  unique(strategies.map(strategy => strategy.teamId), 'strategies');
  strategies.forEach((strategy, index) => {
    const path = `strategies[${index}]`;
    reference(strategy.leagueId === league.id, `${path}.leagueId`);
    reference(teamIds.has(strategy.teamId), `${path}.teamId`);
    if (Object.keys(strategy.targets).length !== NINE_CATEGORIES.length
      || NINE_CATEGORIES.some(category => !CATEGORY_TARGETS.includes(strategy.targets[category]))) add('invalid-value', `${path}.targets`);
  });

  if (draftSession) {
    reference(draftSession.leagueId === league.id, 'draftSession.leagueId');
    if (!draftSession.id.trim()) add('invalid-value', 'draftSession.id');
    const order = draftSession.draftOrder;
    if (order.length !== teams.length || new Set(order).size !== teams.length
      || order.some(id => !teamIds.has(id))) add('draft-order', 'draftSession.draftOrder');
    const count = draftSession.picks.length;
    const total = totalDraftPicks(league.rules);
    if (count > total || (draftSession.status === 'setup' && count !== 0)
      || (draftSession.status === 'inProgress' && (count === 0 || count >= total))
      || (draftSession.status === 'completed' && count !== total)
      || !['setup', 'inProgress', 'completed'].includes(draftSession.status)) add('draft-status', 'draftSession.status');
    draftSession.picks.forEach((pick, index) => {
      const selectionIndex = pick.selectionIndex ?? index;
      if (!Number.isInteger(selectionIndex) || selectionIndex < 0 || selectionIndex >= total) add('invalid-value', `draftSession.picks[${index}].selectionIndex`);
      if (pick.teamId !== snakeTeamAt(order, selectionIndex, league.rules) && pick.outOfTurnConfirmed !== true) add('out-of-turn', `draftSession.picks[${index}]`);
    });
    if (snapshot.rosterEntries.length > 0) add('roster-source', 'rosterEntries');
  }
  // A draft is the sole roster source until explicitly handed off to standalone rosters.
  const entries = draftSession ? deriveDraftRoster(draftSession) : snapshot.rosterEntries;
  const rosterPath = draftSession ? 'draftSession.picks' : 'rosterEntries';
  const assigned = new Set<string>();
  const counts = new Map<string, number>();
  entries.forEach((entry, index) => {
    const path = `${rosterPath}[${index}]`;
    reference(playerIds.has(entry.playerId), `${path}.playerId`);
    reference(teamIds.has(entry.teamId), `${path}.teamId`);
    if (assigned.has(entry.playerId)) add('duplicate-player', `${path}.playerId`);
    assigned.add(entry.playerId);
    const count = (counts.get(entry.teamId) ?? 0) + 1;
    counts.set(entry.teamId, count);
    if (count > league.rules.rosterSize) add('team-capacity', `${path}.teamId`);
    if (entry.preferredSlot !== undefined && !league.rules.rosterSlots.includes(entry.preferredSlot)) add('invalid-value', `${path}.preferredSlot`);
  });
  return issues;
}
