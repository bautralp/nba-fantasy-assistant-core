import type { Result, WorkspaceDataError } from '../../application/ports.ts';
import { CATEGORY_TARGETS, NINE_CATEGORIES, type CategoryTargets } from '../../domain/models/categories.ts';
import type { DraftPick } from '../../domain/models/draft.ts';
import { PROJECTION_STATS, type PlayerProjection, type ProjectionStats } from '../../domain/models/projection.ts';
import { POSITIONS, type PositionEligibility } from '../../domain/models/roster.ts';
import type { WorkspaceSnapshot } from '../../domain/models/workspace.ts';
import { createInitialWorkspace } from '../../domain/rules/createWorkspace.ts';
import { snakeTeamAt } from '../../domain/rules/draftRules.ts';
import { isRecord, parseJson, validateSnapshotData } from './workspaceJson.ts';

export interface LegacyV3Options {
  readonly leagueId: string;
  readonly season: string;
  readonly importedAt: string;
  /** Explicit caller consent, after showing legacy-turn-confirmation-required.
   * v3 stored neither original selection indices nor out-of-turn confirmations.
   */
  readonly confirmUnverifiableTurns?: boolean;
}
export interface MigrationNotice { readonly code: string; readonly path: string }
export type LegacyV3Error = WorkspaceDataError | {
  readonly code: 'legacy-migration'; readonly issues: readonly MigrationNotice[];
};
export interface LegacyV3Migration {
  readonly snapshot: WorkspaceSnapshot;
  readonly notices: readonly MigrationNotice[];
}
const legacyStats = ['fgm', 'fga', 'ftm', 'fta', 'three', 'pts', 'reb', 'ast', 'stl', 'blk', 'to'] as const;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** User-supplied exportBackup() JSON only. No browser storage access or name matching. */
export function migrateLegacyV3Json(json: string, options: LegacyV3Options): Result<LegacyV3Migration, LegacyV3Error> {
  const parsed = parseJson(json);
  if (!parsed.ok) return parsed;
  const data = parsed.value;
  if (isRecord(data) && 'version' in data && data.version !== 3) return { ok: false, error: { code: 'unsupported-schema', path: 'version' } };
  const issues: MigrationNotice[] = [];
  const notices: MigrationNotice[] = [];
  const issue = (code: string, path: string) => { issues.push({ code, path }); };
  const fail = (): Result<never, LegacyV3Error> => ({ ok: false, error: { code: 'legacy-migration', issues } });
  if (!isRecord(data) || data.version !== 3 || !Array.isArray(data.teams) || data.teams.length !== 10
    || data.teams.some(name => typeof name !== 'string') || !Number.isInteger(data.myTeam)
    || (data.myTeam as number) < 0 || (data.myTeam as number) >= 10 || !Array.isArray(data.players)
    || !Array.isArray(data.picks) || !isRecord(data.targets)
    || Object.keys(data.targets).length !== 9
    || NINE_CATEGORIES.some(key => !CATEGORY_TARGETS.includes((data.targets as Record<string, unknown>)[key] as never))) {
    issue('invalid-legacy-shape', '$'); return fail();
  }
  if (!text(options.leagueId) || !text(options.season) || !Number.isFinite(Date.parse(options.importedAt))) {
    issue('invalid-migration-metadata', 'options'); return fail();
  }
  const legacyTeams = data.teams;
  const legacyTargets = data.targets;
  const teamIds = legacyTeams.map((_, i) => `${options.leagueId}:team:${i}`);
  const initial = createInitialWorkspace({ leagueId: options.leagueId, season: options.season, teamIds, draftSessionId: `${options.leagueId}:draft` });
  const players: WorkspaceSnapshot['players'][number][] = [];
  const projections: PlayerProjection[] = [];
  const eligibility: PositionEligibility[] = [];
  const ids = new Map<string, string>();
  const modes = new Set<string>();
  const datasetId = `${options.leagueId}:v3-projections`;
  data.players.forEach((row, index) => {
    const path = `players[${index}]`;
    if (!isRecord(row) || !text(row.id) || !text(row.name)) { issue('unresolvable-player-identity', path); return; }
    if (ids.has(row.id)) { issue('ambiguous-player-id', `${path}.id`); return; }
    // Injective mapping of the exact v3 ID, independent of order/name/stats.
    const id = `v3:${row.id}`;
    ids.set(row.id, id);
    players.push({ id, name: row.name, providerIds: { legacyV3: row.id } });
    if (!['perGame', 'totals'].includes(String(row.mode))) { issue('unknown-projection-unit', `${path}.mode`); return; }
    modes.add(String(row.mode));
    const rank = Number.isInteger(row.rank) && (row.rank as number) > 0 ? { rank: row.rank as number } : {};
    if (row.rank !== null && row.rank !== undefined && !('rank' in rank)) notices.push({ code: 'rank-omitted', path: `${path}.rank` });
    const values = isRecord(row.values) ? row.values : {};
    const valid = row.valid === true && nonnegative(values.gp) && values.gp > 0
      && legacyStats.every(key => nonnegative(values[key]))
      && (values.fgm as number) <= (values.fga as number) && (values.ftm as number) <= (values.fta as number);
    const identity = { playerId: id, datasetId, ...rank };
    if (valid) projections.push({ ...identity, status: 'valid', gamesPlayed: values.gp as number,
      stats: Object.fromEntries(PROJECTION_STATS.map((key, i) => [key, values[legacyStats[i]]])) as unknown as ProjectionStats });
    else {
      projections.push({ ...identity, status: 'excluded', reasons: ['Legacy projection missing, invalid or excluded'] });
      notices.push({ code: 'projection-excluded-raw-values-not-retained', path });
    }
    const tokens = typeof row.pos === 'string' ? row.pos.toUpperCase().split(/[^A-Z]+/).filter(Boolean) : [];
    const positions = [...new Set(tokens.filter((token): token is typeof POSITIONS[number] => POSITIONS.includes(token as never)))];
    if (!positions.length || tokens.some(token => !POSITIONS.includes(token as never))) notices.push({ code: 'unknown-position-omitted', path: `${path}.pos` });
    eligibility.push({ playerId: id, season: options.season, scope: { kind: 'dataset', datasetId }, positions });
    for (const key of Object.keys(row)) if (!['id', 'name', 'rank', 'pos', 'values', 'mode', 'valid'].includes(key)) notices.push({ code: 'unmapped-field', path: `${path}.${key}` });
  });
  if (modes.size > 1) issue('mixed-projection-units', 'players');
  const picks: DraftPick[] = [];
  data.picks.forEach((pick, index) => {
    const path = `picks[${index}]`;
    if (!isRecord(pick) || !text(pick.id) || !ids.has(pick.id)) { issue('unresolvable-pick-identity', path); return; }
    if (!Number.isInteger(pick.team) || (pick.team as number) < 0 || (pick.team as number) >= 10) { issue('invalid-team-reference', path); return; }
    const teamId = teamIds[pick.team as number];
    const mismatch = teamId !== snakeTeamAt(teamIds, index, initial.league.rules);
    if (mismatch && options.confirmUnverifiableTurns !== true) issue('legacy-turn-confirmation-required', path);
    if (mismatch) notices.push({ code: 'legacy-turn-explicitly-confirmed', path });
    picks.push({ playerId: ids.get(pick.id)!, teamId, selectionIndex: index, ...(mismatch ? { outOfTurnConfirmed: true } : {}) });
    for (const key of Object.keys(pick)) if (!['id', 'team'].includes(key)) notices.push({ code: 'unmapped-field', path: `${path}.${key}` });
  });
  if (issues.length) return fail();
  if (picks.length) notices.push({ code: 'original-selection-indices-and-consent-unavailable', path: 'picks' });
  let sourceName = 'v3 JSON backup';
  if (data.source !== null && data.source !== undefined) {
    if (!isRecord(data.source) || !text(data.source.file)) { issue('invalid-source', 'source'); return fail(); }
    sourceName = data.source.file;
    notices.push({ code: 'source-loaded-replaced-by-importedAt', path: 'source.loaded' });
    if (data.source.mode !== undefined && !modes.has(String(data.source.mode))) notices.push({ code: 'source-mode-not-used', path: 'source.mode' });
    for (const key of Object.keys(data.source)) if (!['file', 'loaded', 'mode'].includes(key)) notices.push({ code: 'unmapped-field', path: `source.${key}` });
  }
  for (const key of Object.keys(data)) if (!['version', 'teams', 'myTeam', 'targets', 'players', 'picks', 'source'].includes(key)) notices.push({ code: 'unmapped-field', path: key });
  const snapshot: WorkspaceSnapshot = {
    ...initial,
    league: { ...initial.league, userTeamId: teamIds[data.myTeam as number], activeDatasetId: players.length ? datasetId : null },
    teams: initial.teams.map((team, index) => ({ ...team, name: legacyTeams[index] as string })), players, projections, eligibility,
    datasets: players.length ? [{ id: datasetId, schemaVersion: 1, season: options.season, importedAt: options.importedAt,
      source: { name: sourceName, kind: 'json' }, unit: modes.has('totals') ? 'totals' : 'perGame' }] : [],
    strategies: initial.strategies.map(strategy => strategy.teamId === teamIds[data.myTeam as number]
      ? { ...strategy, targets: { ...legacyTargets } as CategoryTargets } : strategy),
    draftSession: { ...initial.draftSession!, picks, status: picks.length === 130 ? 'completed' : picks.length ? 'inProgress' : 'setup' },
  };
  const checked = validateSnapshotData(snapshot);
  return checked.ok ? { ok: true, value: { snapshot: checked.value, notices } } : checked;
}
