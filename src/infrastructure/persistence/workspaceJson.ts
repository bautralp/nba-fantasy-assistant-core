import type { Result, WorkspaceDataError } from '../../application/ports.ts';
import { NINE_CATEGORIES } from '../../domain/models/categories.ts';
import { PROJECTION_STATS } from '../../domain/models/projection.ts';
import type { WorkspaceSnapshot } from '../../domain/models/workspace.ts';
import { validateWorkspace } from '../../domain/rules/invariants.ts';

// Runtime shape validation precedes the typed domain validator. Reconstructing
// known fields also prevents computed values from leaking into exported backups.
type Shape = 'string' | 'number' | 'boolean' | { readonly [key: string]: Shape } | readonly [Shape];
const strings: Shape = ['string'];
const targets = Object.fromEntries(NINE_CATEGORIES.map(key => [key, 'string'])) as Record<string, Shape>;
const stats = Object.fromEntries(PROJECTION_STATS.map(key => [key, 'number'])) as Record<string, Shape>;
const shape: Shape = {
  schemaVersion: 'number', 'manualDraftLocked?': 'boolean',
  league: { id: 'string', name: 'string', season: 'string', activeDatasetId: 'string', userTeamId: 'string',
    rules: { teamCount: 'number', rosterSize: 'number', draftFormat: 'string', categories: strings, rosterSlots: strings } },
  teams: [{ id: 'string', leagueId: 'string', name: 'string' }],
  players: [{ id: 'string', name: 'string', 'providerIds?': {} }],
  datasets: [{ id: 'string', schemaVersion: 'number', season: 'string', 'period?': 'string', 'rankInputIssue?': 'string',
    'provenance?': { sourceSeason: 'string', sourceKind: 'string', generatedAt: 'string', asOf: 'string', gpMeaning: 'string', positionsSnapshotAt: 'string', 'projectionMode?': 'string', 'modelVersion?': 'string', 'sourceRevision?': 'string', 'horizon?': 'string' },
    source: { name: 'string', kind: 'string' }, importedAt: 'string', unit: 'string' }],
  projections: [{ playerId: 'string', datasetId: 'string', 'rank?': 'number', 'presentation?': { 'team?': 'string', 'mpg?': 'number', 'modelLabel?': 'string' }, status: 'string',
    'gamesPlayed?': 'number', 'stats?': stats, 'reasons?': strings }],
  eligibility: [{ playerId: 'string', season: 'string', scope: { kind: 'string', 'leagueId?': 'string', 'datasetId?': 'string' }, positions: strings }],
  strategies: [{ leagueId: 'string', teamId: 'string', targets }],
  draftSession: { id: 'string', leagueId: 'string', draftOrder: strings, status: 'string',
    picks: [{ playerId: 'string', teamId: 'string', 'selectionIndex?': 'number', 'outOfTurnConfirmed?': 'boolean' }] },
  rosterEntries: [{ playerId: 'string', teamId: 'string', 'preferredSlot?': 'string' }],
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
class ShapeError extends Error {
  readonly path: string;
  constructor(path: string) { super(path); this.path = path; }
}
function decode(value: unknown, expected: Shape, path: string, strict: boolean): unknown {
  if (value === null && ['$.draftSession', '$.league.activeDatasetId', '$.league.userTeamId'].includes(path)) return null;
  if (typeof expected === 'string') {
    if (typeof value !== expected || (expected === 'number' && !Number.isFinite(value))) throw new ShapeError(path);
    return value;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(value)) throw new ShapeError(path);
    return value.map((item, index) => decode(item, expected[0], `${path}[${index}]`, strict));
  }
  if (!isRecord(value)) throw new ShapeError(path);
  if (path.match(/^\$\.projections\[\d+\]$/) && !['valid', 'excluded'].includes(String(value.status))) throw new ShapeError(`${path}.status`);
  // The only free-form dictionary in the snapshot is providerIds.
  if (Object.keys(expected).length === 0) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, 'string', `${path}.${key}`, strict)]));
  }
  const fields = Object.entries(expected).filter(([key]) => {
    // Discriminated variants must carry exactly their own payload.
    if (path.match(/^\$\.projections\[\d+\]$/)) {
      if (['gamesPlayed?', 'stats?'].includes(key)) return value.status === 'valid';
      if (key === 'reasons?') return value.status === 'excluded';
    }
    if (path.endsWith('.scope')) {
      if (key === 'leagueId?') return value.kind === 'league';
      if (key === 'datasetId?') return value.kind === 'dataset';
    }
    return true;
  });
  const keys = fields.map(([key]) => key.replace(/\?$/, ''));
  if (strict && Object.keys(value).some(key => !keys.includes(key))) throw new ShapeError(path);
  const output = Object.fromEntries(fields.flatMap(([rawKey, fieldShape]) => {
    const key = rawKey.replace(/\?$/, '');
    const variantRequired = ['gamesPlayed', 'stats', 'reasons', 'leagueId', 'datasetId'].includes(key);
    if (rawKey.endsWith('?') && !variantRequired && value[key] === undefined) return [];
    return [[key, decode(value[key], fieldShape, `${path}.${key}`, strict)]];
  }));
  if (path.endsWith('.scope') && !['league', 'dataset'].includes(String(value.kind))) throw new ShapeError(`${path}.kind`);
  return output;
}

/** Accept untrusted JSON data; no storage or live state is touched. */
export function validateSnapshotData(value: unknown, strict = true): Result<WorkspaceSnapshot, WorkspaceDataError> {
  if (isRecord(value) && 'schemaVersion' in value && value.schemaVersion !== 1) {
    return { ok: false, error: { code: 'unsupported-schema', path: 'schemaVersion' } };
  }
  try {
    const snapshot = decode(value, shape, '$', strict) as WorkspaceSnapshot;
    const issues = validateWorkspace(snapshot);
    const unsupported = issues.find(issue => issue.code === 'unsupported-schema');
    if (unsupported) return { ok: false, error: { code: 'unsupported-schema', path: unsupported.path } };
    return issues.length ? { ok: false, error: { code: 'invalid-data', issues } } : { ok: true, value: snapshot };
  } catch (error) {
    if (!(error instanceof ShapeError)) throw error;
    return { ok: false, error: { code: 'invalid-data', issues: [{ code: 'invalid-value', path: error.path }] } };
  }
}
export function parseJson(text: string): Result<unknown, WorkspaceDataError> {
  try { return { ok: true, value: JSON.parse(text) as unknown }; }
  catch { return { ok: false, error: { code: 'invalid-json' } }; }
}
/** Snapshot schemaVersion is also the portable JSON format version. */
export function restoreWorkspaceJson(text: string): Result<WorkspaceSnapshot, WorkspaceDataError> {
  const parsed = parseJson(text);
  return parsed.ok ? validateSnapshotData(parsed.value) : parsed;
}
export function exportWorkspaceJson(snapshot: WorkspaceSnapshot): Result<string, WorkspaceDataError> {
  try {
    // Detect cycles/BigInt before writing anything; never mutate input data.
    const serialized = JSON.stringify(snapshot);
    const validated = validateSnapshotData(JSON.parse(serialized) as unknown, false);
    return validated.ok ? { ok: true, value: JSON.stringify(validated.value, null, 2) } : validated;
  } catch { return { ok: false, error: { code: 'serialization' } }; }
}
