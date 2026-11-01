import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageWorkspaceRepository, WORKSPACE_STORAGE_KEY as key } from '../../src/infrastructure/persistence/localStorageWorkspaceRepository.ts';
import { WorkspaceStore } from '../../src/application/workspaceStore.ts';
import { fresh } from '../helpers/draftFixture.ts';
import { exportWorkspaceJson, restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
const setup = () => {
  const data = new Map([[key, JSON.stringify(fresh())]]);
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  return { data, storage, a: new LocalStorageWorkspaceRepository(() => storage), b: new LocalStorageWorkspaceRepository(() => storage) };
};
test('stale tab cannot overwrite latest snapshot; JSON recovery preserves unsaved work', async () => {
  const { a, b, data } = setup(); const sa = new WorkspaceStore(a), sb = new WorkspaceStore(b); await Promise.all([sa.load(), sb.load()]);
  const wa = { ...fresh(), league: { ...fresh().league, name: 'Synthetic A' } }, wb = { ...fresh(), league: { ...fresh().league, name: 'Synthetic B' } };
  assert.ok(sa.accept(wa)); assert.ok(sb.accept(wb)); await sa.save(); const saved = data.get(key);
  await sb.save(); assert.equal(sb.getSnapshot().error?.code, 'storage-conflict'); assert.equal(sb.getSnapshot().conflict, true);
  assert.equal(sb.getSnapshot().dirty, true); assert.equal(sb.getSnapshot().workspace, wb); assert.equal(data.get(key), saved);
  const backup = exportWorkspaceJson(sb.getSnapshot().workspace!); assert.ok(backup.ok); const restored = restoreWorkspaceJson(backup.value); assert.ok(restored.ok); assert.deepEqual(restored.value, wb);
  await sb.loadLatest(); assert.deepEqual(sb.getSnapshot().workspace, wa); assert.equal(sb.getSnapshot().dirty, false); assert.equal(sb.getSnapshot().conflict, false);
});
test('storage checks detect changes and deletion without replacing either clean or dirty in-memory work', async () => {
  for (const dirty of [true, false]) {
    const { a, b, data } = setup(); const store = new WorkspaceStore(b); await store.load(); await a.load();
    if (dirty) store.accept(fresh(150)); const before = store.getSnapshot().workspace;
    await a.save({ ...fresh(), league: { ...fresh().league, name: 'Changed' } }); await store.checkForChanges();
    assert.equal(store.getSnapshot().conflict, true); assert.equal(store.getSnapshot().workspace, before);
    data.delete(key); await store.checkForChanges(); await store.loadLatest(); assert.equal(store.getSnapshot().workspace, before);
  }
});
test('failed explicit reload preserves memory and corrupt record; quota/access failures never advance baseline', async () => {
  const { a, b, storage, data } = setup(); await a.load(); const store = new WorkspaceStore(b); await store.load(); store.accept(fresh(150)); const before = store.getSnapshot().workspace;
  data.set(key, '{'); await store.checkForChanges(); await store.loadLatest(); assert.equal(data.get(key), '{'); assert.equal(store.getSnapshot().workspace, before); assert.equal(store.getSnapshot().dirty, true);
  data.set(key, JSON.stringify(fresh())); const original = storage.setItem;
  for (const [name, code] of [['QuotaExceededError','storage-quota'], ['SecurityError','storage-access']]) {
    storage.setItem = () => { throw { name }; }; const result = await a.save(fresh(300)); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, code);
    assert.deepEqual(await a.checkForChanges(), { ok: true, value: false });
  }
  storage.setItem = original; assert.ok((await a.save(fresh(300))).ok);
});
test('late save cannot accept edits or claim that rejected edits were saved', async () => {
  let finish!: (value: { ok: true; value: undefined }) => void;
  const store = new WorkspaceStore({ load: async () => ({ ok: true, value: fresh() }), save: () => new Promise(resolve => { finish = resolve; }) }); await store.load(); store.accept(fresh(150));
  const saving = store.save(); assert.equal(store.accept(fresh(600)), false); finish({ ok: true, value: undefined }); await saving;
  assert.equal(store.getSnapshot().workspace!.players.length, 150); assert.equal(store.getSnapshot().dirty, false);
});

test('failed first load cannot overwrite an unseen valid record after storage access recovers', async () => {
  const { data, storage } = setup();
  const existing = data.get(key);
  const originalGetItem = storage.getItem;
  storage.getItem = () => { throw new DOMException('Temporarily unavailable', 'SecurityError'); };
  const store = new WorkspaceStore(new LocalStorageWorkspaceRepository(() => storage));
  await store.load();
  assert.equal(store.getSnapshot().error?.code, 'storage-access');
  assert.equal(data.get(key), existing);
  const working = fresh(150);
  assert.ok(store.accept(working));
  storage.getItem = originalGetItem;
  await store.save();
  assert.equal(data.get(key), existing);
  assert.equal(store.getSnapshot().error?.code, 'storage-conflict');
  assert.equal(store.getSnapshot().conflict, true);
  assert.equal(store.getSnapshot().dirty, true);
  assert.equal(store.getSnapshot().workspace, working);
  const json = exportWorkspaceJson(store.getSnapshot().workspace!);
  assert.ok(json.ok);
  const restored = restoreWorkspaceJson(json.value);
  assert.ok(restored.ok);
  assert.deepEqual(restored.value, working);
  await store.loadLatest();
  assert.deepEqual(store.getSnapshot().workspace, fresh());
  assert.equal(store.getSnapshot().conflict, false);
  assert.equal(store.getSnapshot().dirty, false);
  // The explicitly loaded record establishes a baseline for subsequent saves.
  assert.ok(store.accept(working));
  await store.save();
  assert.equal(store.getSnapshot().error, null);
  assert.deepEqual(JSON.parse(data.get(key)!), working);
});

test('undefined baseline permits first save only into empty storage, including after a failed load', async () => {
  for (const failLoad of [false, true]) {
    const { data, storage } = setup();
    data.delete(key);
    let blocked = failLoad;
    const repository = new LocalStorageWorkspaceRepository(() => {
      if (blocked) throw new DOMException('Temporarily unavailable', 'SecurityError');
      return storage;
    });
    if (failLoad) assert.deepEqual(await repository.load(), { ok: false, error: { code: 'storage-access' } });
    blocked = false;
    assert.ok((await repository.save(fresh(150))).ok);
    assert.deepEqual(JSON.parse(data.get(key)!), fresh(150));
    assert.ok((await repository.save(fresh(300))).ok);
  }
});

test('undefined baseline rejects unseen valid records and preserves corrupt-record error precedence', async () => {
  for (const existing of [JSON.stringify(fresh()), '{']) {
    const { data, storage } = setup(); data.set(key, existing);
    const repository = new LocalStorageWorkspaceRepository(() => storage);
    const result = await repository.save(fresh(150));
    assert.deepEqual(result.ok ? null : result.error.code, existing === '{' ? 'existing-record-invalid' : 'storage-conflict');
    assert.equal(data.get(key), existing);
  }
});
