import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyLeagueSettings, blankLeagueSettings, settingsFromWorkspace, validateLeagueSettings } from '../../src/application/leagueSetup.ts';
import { WorkspaceStore } from '../../src/application/workspaceStore.ts';
import type { Result, RepositoryError, WorkspaceRepository } from '../../src/application/ports.ts';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import { snakeTeamAt } from '../../src/domain/rules/draftRules.ts';
import { migrateLegacyV3Json } from '../../src/infrastructure/persistence/legacyV3.ts';
const valid = () => {
  const form = blankLeagueSettings();
  return { ...form, name: 'Test League', season: '2026-27', userTeamId: form.teams[3].id, teams: form.teams.map((team, i) => ({ ...team, name: `Team ${i + 1}` })) };
};
const fresh = () => { const result = applyLeagueSettings(valid(), null); assert.ok(result.ok); return result.value; };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const repository = (): WorkspaceRepository => ({ load: async () => ({ ok: true, value: null }), save: async () => ({ ok: true, value: undefined }) });

test('empty setup has independent random IDs and no prefilled business values', () => {
  const a = blankLeagueSettings(), b = blankLeagueSettings();
  assert.equal(a.name, ''); assert.equal(a.season, ''); assert.equal(a.userTeamId, '');
  assert.ok(a.teams.every(team => team.name === '')); assert.equal(new Set([...a.draftOrder, ...b.draftOrder]).size, 20);
});
test('required fields, all duplicate spellings and permutations are rejected', () => {
  const empty = blankLeagueSettings();
  assert.equal(Object.keys(validateLeagueSettings(empty)).length, 13);
  for (const duplicate of ['TEAM 1', ' team 1 ', 'Team 1']) {
    const form = valid(); const errors = validateLeagueSettings({ ...form, teams: form.teams.map((team, i) => i === 2 ? { ...team, name: duplicate } : team) });
    assert.ok(errors[form.teams[0].id]); assert.ok(errors[form.teams[2].id]);
  }
  const form = valid(); assert.ok(validateLeagueSettings({ ...form, draftOrder: form.draftOrder.map(() => form.teams[0].id) }).draftOrder);
});
test('creation uses caller IDs, keeps ten teams, user selection, empty data and unset targets', () => {
  const form = valid(); let calls = 0;
  const result = applyLeagueSettings(form, null, () => `independent-${calls++}`); assert.ok(result.ok);
  const snapshot = result.value;
  assert.equal(snapshot.league.id, 'independent-0'); assert.equal(snapshot.draftSession!.id, 'independent-1');
  assert.equal(snapshot.league.userTeamId, form.teams[3].id); assert.deepEqual(snapshot.teams.map(team => team.name), form.teams.map(team => team.name));
  for (const key of ['players', 'projections', 'datasets', 'eligibility', 'rosterEntries'] as const) assert.deepEqual(snapshot[key], []);
  assert.deepEqual(snapshot.draftSession!.picks, []); assert.ok(snapshot.strategies.every(strategy => Object.values(strategy.targets).every(target => target === 'unset')));
});
test('draft reordering preserves identity, user team and snake round reversal', () => {
  const snapshot = fresh(); const form = settingsFromWorkspace(snapshot);
  const result = applyLeagueSettings({ ...form, draftOrder: [...form.draftOrder].reverse() }, snapshot); assert.ok(result.ok);
  assert.deepEqual(result.value.teams, snapshot.teams); assert.equal(result.value.league.userTeamId, snapshot.league.userTeamId);
  const session = result.value.draftSession!;
  assert.equal(snakeTeamAt(session.draftOrder, 9, snapshot.league.rules), snakeTeamAt(session.draftOrder, 10, snapshot.league.rules));
  assert.equal(snakeTeamAt(session.draftOrder, 0, snapshot.league.rules), snakeTeamAt(session.draftOrder, 19, snapshot.league.rules));
});
test('drafted imports preserve every data collection on settings edits and reject order and incompatible season changes', () => {
  const result = migrateLegacyV3Json(readFileSync(new URL('../fixtures/persistence/v3-backup.json', import.meta.url), 'utf8'), { leagueId: 'test', season: '2026-27', importedAt: new Date().toISOString(), confirmUnverifiableTurns: true }); assert.ok(result.ok);
  const original = result.value.snapshot; const before = JSON.stringify(original);
  const form = { ...settingsFromWorkspace(original), name: 'Renamed', userTeamId: original.teams[9].id, teams: original.teams.map(team => ({ ...team, name: `New ${team.name}` })) };
  const updated = applyLeagueSettings(form, original); assert.ok(updated.ok);
  for (const key of ['players', 'projections', 'datasets', 'eligibility', 'strategies', 'rosterEntries', 'draftSession'] as const) assert.equal(updated.value[key], original[key]);
  assert.equal(applyLeagueSettings({ ...form, draftOrder: [...form.draftOrder].reverse() }, original).ok, false);
  assert.equal(applyLeagueSettings({ ...form, season: 'different' }, original).ok, false);
  assert.equal(JSON.stringify(original), before);
});
test('team identity replacement is rejected even if the resulting shape would be valid', () => {
  const snapshot = fresh(), form = settingsFromWorkspace(snapshot);
  assert.equal(applyLeagueSettings({ ...form, teams: form.teams.map(team => ({ ...team, id: `other-${team.id}` })), draftOrder: form.draftOrder.map(id => `other-${id}`), userTeamId: `other-${form.userTeamId}` }, snapshot).ok, false);
});
test('load distinguishes missing, loaded, corrupt and inaccessible records', async () => {
  const snapshot = fresh();
  for (const value of [null, snapshot]) {
    const store = new WorkspaceStore({ ...repository(), load: async () => ({ ok: true, value }) }); await store.load();
    assert.equal(store.getSnapshot().load, value ? 'loaded' : 'missing'); assert.equal(store.getSnapshot().workspace, value);
  }
  for (const code of ['invalid-json', 'storage-access'] as const) {
    const store = new WorkspaceStore({ ...repository(), load: async () => ({ ok: false, error: { code } }) }); await store.load();
    assert.equal(store.getSnapshot().load, 'error'); assert.equal(store.getSnapshot().error!.code, code);
  }
});
test('load is single-flight, cannot overwrite new work and invalid snapshots never enter state', async () => {
  const loading = deferred<Result<WorkspaceSnapshot | null, RepositoryError>>(); let calls = 0;
  const store = new WorkspaceStore({ ...repository(), load: () => { calls++; return loading.promise; } });
  const a = store.load(), b = store.load(); assert.equal(a, b); assert.equal(calls, 1);
  assert.equal(store.accept(fresh()), false);
  loading.resolve({ ok: true, value: null }); await a;
  const snapshot = fresh(); assert.ok(store.accept(snapshot));
  await store.load(); assert.equal(store.getSnapshot().workspace, snapshot);
  assert.equal(store.accept({ ...snapshot, teams: [] }), false);
});
test('delayed saves never resurrect old work and concurrent saves/replacements are blocked', async () => {
  const pending = deferred<Result<void, RepositoryError>>(); let writes = 0;
  const store = new WorkspaceStore({ ...repository(), save: () => { writes++; return pending.promise; } }); await store.load();
  const snapshot = fresh(); store.accept(snapshot); const saving = store.save(); await store.save();
  assert.equal(writes, 1); assert.equal(store.accept(fresh()), false);
  pending.resolve({ ok: true, value: undefined }); await saving;
  assert.equal(store.getSnapshot().workspace, snapshot); assert.equal(store.getSnapshot().dirty, false);
  const next = fresh(); store.accept(next); assert.equal(store.getSnapshot().workspace, next); assert.equal(store.getSnapshot().dirty, true);
});
test('quota, access errors and rejected repository promises preserve the in-memory accepted workspace', async () => {
  for (const code of ['storage-quota', 'storage-access', 'existing-record-invalid'] as const) {
    const error: RepositoryError = code === 'existing-record-invalid' ? { code, reason: { code: 'invalid-json' } } : { code };
    const store = new WorkspaceStore({ ...repository(), save: async () => ({ ok: false, error }) }); await store.load();
    const snapshot = fresh(); store.accept(snapshot); await store.save();
    assert.equal(store.getSnapshot().workspace, snapshot); assert.equal(store.getSnapshot().dirty, true); assert.equal(store.getSnapshot().error!.code, code);
    assert.match(store.getSnapshot().message, /JSON/);
  }
  const store = new WorkspaceStore({ ...repository(), save: async () => { throw Error('unavailable'); } }); await store.load();
  const snapshot = fresh(); store.accept(snapshot); await store.save(); assert.equal(store.getSnapshot().workspace, snapshot); assert.equal(store.getSnapshot().saving, false);
});
