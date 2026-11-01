import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { Result } from '../../src/application/ports.ts';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';
import { appendDraftPick, removeDraftPick, snakeTeamAt } from '../../src/domain/rules/draftRules.ts';
import { validateWorkspace } from '../../src/domain/rules/invariants.ts';
import { calculateModel } from '../../src/engine/index.ts';
import { LocalStorageWorkspaceRepository, WORKSPACE_STORAGE_KEY, type WorkspaceStorage } from '../../src/infrastructure/persistence/localStorageWorkspaceRepository.ts';
import { exportWorkspaceJson, restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { migrateLegacyV3Json, type LegacyV3Options } from '../../src/infrastructure/persistence/legacyV3.ts';

function value<T, E>(result: Result<T, E>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw Error('unreachable'); return result.value; }
function errorCode<T, E extends { code: string }>(result: Result<T, E>): string { assert.equal(result.ok, false); if (result.ok) throw Error('unreachable'); return result.error.code; }
function fresh(): WorkspaceSnapshot {
  return createInitialWorkspace({ leagueId: 'league', season: '2026-27', teamIds: Array.from({ length: 10 }, (_, i) => `t${i}`), draftSessionId: 'draft' });
}
function drafted(count: number): WorkspaceSnapshot {
  const initial = fresh();
  const players = Array.from({ length: count + 1 }, (_, i) => ({ id: `p${i}`, name: `Synthetic ${i}` }));
  let draft = initial.draftSession!;
  for (const player of players.slice(0, count)) draft = appendDraftPick(draft, { playerId: player.id,
    teamId: snakeTeamAt(draft.draftOrder, draft.picks.length, initial.league.rules)! }, initial.league.rules);
  return { ...initial, players, draftSession: draft };
}
class FakeStorage implements WorkspaceStorage {
  data = new Map<string, string>();
  reads: string[] = [];
  writes = 0;
  readError: unknown;
  writeError: unknown;
  getItem(key: string) { this.reads.push(key); if (this.readError) throw this.readError; return this.data.get(key) ?? null; }
  setItem(key: string, item: string) { this.writes++; if (this.writeError) throw this.writeError; this.data.set(key, item); }
}
const options: LegacyV3Options = { leagueId: 'migrated', season: '2026-27', importedAt: '2026-10-20T12:00:00Z' };
const legacy = JSON.parse(readFileSync(new URL('../fixtures/persistence/v3-backup.json', import.meta.url), 'utf8')) as {
  version: number; teams: string[]; myTeam: number; targets: Record<string, string>; source: { file: string };
  players: { id: string; name: string; rank: number; pos: string; values: Record<string, number | null>; mode: string; valid: boolean }[];
  picks: { id: string; team: number }[];
};
const migrate = (data: unknown = legacy, consent = true) => migrateLegacyV3Json(JSON.stringify(data), { ...options, confirmUnverifiableTurns: consent });

test('missing record differs from corrupt data; empty, partial and completed drafts round-trip', async () => {
  for (const snapshot of [fresh(), drafted(23), drafted(130)]) {
    const storage = new FakeStorage();
    const repository = new LocalStorageWorkspaceRepository(() => storage);
    assert.equal(value(await repository.load()), null);
    value(await repository.save(snapshot));
    assert.deepEqual(value(await repository.load()), snapshot);
    assert.equal(storage.writes, 1);
    assert.deepEqual([...new Set(storage.reads)], [WORKSPACE_STORAGE_KEY]);
  }
});

test('historical indices, confirmations and picks without projections survive storage and portable backup', async () => {
  let snapshot = drafted(23);
  let draft = removeDraftPick(snapshot.draftSession!, 'p0');
  draft = appendDraftPick(draft, { playerId: 'p23', teamId: 't8', outOfTurnConfirmed: true }, snapshot.league.rules);
  snapshot = { ...snapshot, draftSession: draft };
  const storage = new FakeStorage();
  const repository = new LocalStorageWorkspaceRepository(() => storage);
  value(await repository.save(snapshot));
  const restored = value(restoreWorkspaceJson(value(exportWorkspaceJson(snapshot))));
  assert.deepEqual(restored, snapshot);
  assert.deepEqual(value(await repository.load()), snapshot);
  assert.deepEqual(validateWorkspace(restored), []);
  assert.equal(restored.draftSession!.picks.at(-1)!.outOfTurnConfirmed, true);
});

test('all persisted fields including standalone rosters and optional metadata round-trip', () => {
  const migrated = value(migrate()).snapshot;
  const snapshot: WorkspaceSnapshot = { ...migrated,
    league: { ...migrated.league, name: 'Imported league' },
    datasets: migrated.datasets.map(dataset => ({ ...dataset, period: 'season' })),
    draftSession: null, rosterEntries: [{ playerId: migrated.players[0].id, teamId: migrated.teams[0].id, preferredSlot: 'PG' }],
    eligibility: [...migrated.eligibility, { playerId: migrated.players[0].id, season: options.season, scope: { kind: 'league', leagueId: options.leagueId }, positions: ['G', 'F'] }],
  };
  assert.deepEqual(value(restoreWorkspaceJson(value(exportWorkspaceJson(snapshot)))), snapshot);
});

test('computed data is omitted at every object level on export', () => {
  const snapshot = value(migrate()).snapshot;
  const withComputed = { ...snapshot, zScores: [1], recommendations: [1],
    players: snapshot.players.map(player => ({ ...player, score: 5 })),
    projections: snapshot.projections.map(projection => ({ ...projection, zScore: 7 })),
  };
  const json = value(exportWorkspaceJson(withComputed));
  assert.deepEqual(value(restoreWorkspaceJson(json)), snapshot);
  assert.ok(!/zScore|recommendations|"score"/.test(json));
});

test('malformed, incomplete, wrong shapes and references are rejected without changing current workspace', () => {
  const current = drafted(3);
  const before = JSON.stringify(current);
  const sample = value(migrate()).snapshot;
  const corruptions: unknown[] = [null, [], {}, { ...current, teams: null }, { ...current, players: [null] },
    { ...current, draftSession: { ...current.draftSession, picks: [{ playerId: 'missing', teamId: 't0' }] } },
    { ...sample, projections: [{ ...sample.projections[0], status: 'unknown' }] },
    { ...sample, projections: [{ ...sample.projections[0], stats: null }] },
    { ...sample, eligibility: [{ ...sample.eligibility[0], scope: { kind: 'unknown' } }] },
    { ...sample, strategies: [{ ...sample.strategies[0], targets: {} }] },
    { ...sample, datasets: [{ ...sample.datasets[0], importedAt: 'unknown' }] },
    { ...sample, players: [{ id: 'p', name: 'P', providerIds: { legacyV3: 4 } }] },
  ];
  assert.equal(errorCode(restoreWorkspaceJson('{')), 'invalid-json');
  assert.equal(errorCode(restoreWorkspaceJson('')), 'invalid-json');
  for (const corrupted of corruptions) assert.equal(errorCode(restoreWorkspaceJson(JSON.stringify(corrupted))), 'invalid-data');
  assert.equal(JSON.stringify(current), before);
  assert.equal(errorCode(restoreWorkspaceJson(JSON.stringify({ ...current, schemaVersion: 42 }))), 'unsupported-schema');
  assert.equal(errorCode(restoreWorkspaceJson(JSON.stringify({ ...sample, datasets: [{ ...sample.datasets[0], schemaVersion: 2 }] }))), 'unsupported-schema');
});

test('storage getter, read, quota and write failures report errors; memory, previous record and independent JSON remain usable', async () => {
  assert.equal(errorCode(await new LocalStorageWorkspaceRepository(() => { throw new Error('denied'); }).load()), 'storage-access');
  assert.equal(errorCode(await new LocalStorageWorkspaceRepository(() => { throw new Error('denied'); }).save(fresh())), 'storage-access');
  const storage = new FakeStorage();
  const repository = new LocalStorageWorkspaceRepository(() => storage);
  const previous = drafted(1);
  const current = drafted(2);
  const before = JSON.stringify(current);
  value(await repository.save(previous));
  const record = storage.data.get(WORKSPACE_STORAGE_KEY);
  for (const name of ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED', 'SecurityError']) {
    storage.writeError = Object.assign(new Error('blocked'), { name });
    assert.equal(errorCode(await repository.save(current)), name === 'SecurityError' ? 'storage-access' : 'storage-quota');
    assert.equal(storage.data.get(WORKSPACE_STORAGE_KEY), record);
    assert.deepEqual(value(await repository.load()), previous);
    assert.equal(JSON.stringify(current), before);
    assert.deepEqual(value(restoreWorkspaceJson(value(exportWorkspaceJson(current)))), current);
  }
  storage.readError = new Error('denied');
  assert.equal(errorCode(await repository.load()), 'storage-access');
  assert.equal(errorCode(await repository.save(current)), 'storage-access');
  assert.equal(storage.data.get(WORKSPACE_STORAGE_KEY), record);
});

test('serialization and validation failures never write; invalid existing records are never overwritten or deleted', async () => {
  const storage = new FakeStorage();
  const repository = new LocalStorageWorkspaceRepository(() => storage);
  const snapshot = fresh();
  const cyclic = { ...snapshot, cyclic: {} };
  cyclic.cyclic = cyclic;
  assert.equal(errorCode(await repository.save(cyclic)), 'serialization');
  const withBigInt = { ...snapshot, bigint: BigInt(2) };
  assert.equal(errorCode(exportWorkspaceJson(withBigInt)), 'serialization');
  assert.equal(errorCode(await repository.save({ ...snapshot, teams: [] })), 'invalid-data');
  assert.equal(storage.writes, 0);
  for (const record of ['{', '', '{}', '{"schemaVersion":20}', JSON.stringify(legacy)]) {
    storage.data.set(WORKSPACE_STORAGE_KEY, record);
    assert.equal((await repository.load()).ok, false);
    assert.equal(errorCode(await repository.save(snapshot)), 'existing-record-invalid');
    assert.equal(storage.data.get(WORKSPACE_STORAGE_KEY), record);
    assert.equal(storage.writes, 0);
  }
});

test('realistic v3 export retains chronological selection ownership, team names, targets and invalid selected players', () => {
  const before = JSON.stringify(legacy);
  assert.equal(errorCode(migrate(legacy, false)), 'legacy-migration');
  const { snapshot, notices } = value(migrate());
  assert.deepEqual(validateWorkspace(snapshot), []);
  assert.deepEqual(snapshot.teams.map(team => team.name), legacy.teams);
  assert.equal(snapshot.league.userTeamId, snapshot.teams[legacy.myTeam].id);
  assert.deepEqual(snapshot.strategies.find(strategy => strategy.teamId === snapshot.league.userTeamId)!.targets, legacy.targets);
  assert.deepEqual(snapshot.draftSession!.picks.map(pick => ({ id: snapshot.players.find(player => player.id === pick.playerId)!.providerIds!.legacyV3,
    team: snapshot.teams.findIndex(team => team.id === pick.teamId) })), legacy.picks);
  assert.ok(snapshot.draftSession!.picks.some(pick => pick.playerId === 'v3:syntheticplayer4'));
  assert.equal(snapshot.projections.find(row => row.playerId === 'v3:syntheticplayer4')!.status, 'excluded');
  const model = calculateModel(snapshot.players, snapshot.projections, snapshot.datasets[0]);
  assert.equal(model.z.has('v3:syntheticplayer4'), false);
  assert.equal(snapshot.datasets[0].source.name, legacy.source.file);
  for (const code of ['original-selection-indices-and-consent-unavailable', 'legacy-turn-explicitly-confirmed', 'projection-excluded-raw-values-not-retained', 'source-loaded-replaced-by-importedAt', 'unmapped-field']) assert.ok(notices.some(notice => notice.code === code));
  assert.equal(JSON.stringify(legacy), before);
  assert.deepEqual(value(restoreWorkspaceJson(value(exportWorkspaceJson(snapshot)))), snapshot);
  const removed = removeDraftPick(snapshot.draftSession!, snapshot.draftSession!.picks[0].playerId);
  assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: removed }), []);
});

test('v3 mapping uses exact IDs, independent of row order or renaming; duplicate names do not merge players', () => {
  const original = value(migrate()).snapshot;
  const changed = value(migrate({ ...legacy, players: [...legacy.players].reverse().map(row => ({ ...row, name: 'Same name' })) })).snapshot;
  assert.deepEqual(changed.draftSession, original.draftSession);
  assert.equal(new Set(changed.players.map(player => player.id)).size, legacy.players.length);
});

test('v3 missing projections retain identity; unknown positions and fractional rank produce notices', () => {
  const players = legacy.players.map((row, i) => i === 4 ? { ...row, values: null, pos: 'UNKNOWN', rank: 1.5 } : row);
  const migrated = value(migrate({ ...legacy, players }));
  assert.equal(migrated.snapshot.projections.find(row => row.playerId === 'v3:syntheticplayer4')!.status, 'excluded');
  assert.ok(migrated.notices.some(notice => notice.code === 'rank-omitted'));
  assert.ok(migrated.notices.some(notice => notice.code === 'unknown-position-omitted'));
  for (const values of [{ ...legacy.players[4].values, gp: 0 }, { ...legacy.players[4].values, gp: 72, fgm: 20 }, { ...legacy.players[4].values, gp: 72, to: -1 }]) {
    const invalid = value(migrate({ ...legacy, players: legacy.players.map((row, i) => i === 4 ? { ...row, values, valid: true } : row) })).snapshot;
    assert.equal(invalid.projections.find(row => row.playerId === 'v3:syntheticplayer4')!.status, 'excluded');
    assert.ok(invalid.draftSession!.picks.some(pick => pick.playerId === 'v3:syntheticplayer4'));
  }
});

test('v3 rejects ambiguous IDs, missing selected identity, invalid references, capacity, targets and mixed units', () => {
  const current = fresh();
  const before = JSON.stringify(current);
  const cases = [
    { ...legacy, players: [...legacy.players, legacy.players[0]] },
    { ...legacy, players: legacy.players.filter(row => row.id !== legacy.picks[0].id) },
    { ...legacy, players: [{ ...legacy.players[0], id: '' }] },
    { ...legacy, picks: [{ id: 'unknown', team: 0 }] },
    { ...legacy, picks: [{ ...legacy.picks[0], team: 10 }] },
    { ...legacy, picks: [legacy.picks[0], legacy.picks[0]] },
    { ...legacy, picks: legacy.players.slice(0, 14).map(row => ({ id: row.id, team: 0 })) },
    { ...legacy, players: legacy.players.map((row, i) => i === 0 ? { ...row, mode: 'totals' } : row) },
    { ...legacy, targets: { ...legacy.targets, PTS: 'top2' } },
  ];
  for (const input of cases) assert.equal(migrate(input).ok, false);
  assert.equal(errorCode(migrate({ ...legacy, version: 4 })), 'unsupported-schema');
  assert.equal(errorCode(migrateLegacyV3Json('{', options)), 'invalid-json');
  assert.equal(migrateLegacyV3Json(JSON.stringify(legacy), { ...options, importedAt: 'unknown' }).ok, false);
  assert.equal(JSON.stringify(current), before);
});

test('empty and completed v3 drafts and totals are supported; actual frozen importer records are accepted', () => {
  const empty = value(migrate({ ...legacy, players: [], picks: [], source: null })).snapshot;
  assert.equal(empty.draftSession!.status, 'setup');
  const players = Array.from({ length: 130 }, (_, i) => ({ ...legacy.players[0], id: `full-${i}`, mode: 'totals' }));
  const picks = players.map((row, i) => ({ id: row.id, team: Math.floor(i / 10) % 2 === 0 ? i % 10 : 9 - i % 10 }));
  const completed = value(migrate({ ...legacy, players, picks })).snapshot;
  assert.equal(completed.draftSession!.status, 'completed');
  assert.equal(completed.datasets[0].unit, 'totals');
  const frozen = JSON.parse(readFileSync(new URL('../fixtures/expected/early.json', import.meta.url), 'utf8'));
  assert.ok(frozen.imported.records.length);
  const actual = value(migrate({ ...legacy, players: frozen.imported.records, picks: [] })).snapshot;
  assert.equal(actual.players.length, frozen.imported.records.length);
});

test('persistence reads only its own key and migration has no storage or legacy HTML dependency', async () => {
  const storage = new FakeStorage();
  storage.data.set('unrelated-application', 'private');
  const repository = new LocalStorageWorkspaceRepository(() => storage);
  value(await repository.save(fresh()));
  value(await repository.load());
  assert.ok(storage.reads.every(key => key === WORKSPACE_STORAGE_KEY));
  assert.equal(storage.data.get('unrelated-application'), 'private');
  for (const name of readdirSync(new URL('../../src/infrastructure/persistence/', import.meta.url)).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(`../../src/infrastructure/persistence/${name}`, import.meta.url), 'utf8');
    if (name !== 'localStorageWorkspaceRepository.ts') assert.ok(!/localStorage|sessionStorage|v3\.3\.html/.test(source));
    assert.ok(!/\.clear\(/.test(source));
    if (name !== 'localStorageWorkspaceRepository.ts') assert.ok(!/removeItem/.test(source));
    else {
      assert.match(source, /storage\.removeItem\(this.key\)/);
      assert.doesNotMatch(source.slice(source.indexOf('  async save(')), /removeItem/);
    }
  }
});
