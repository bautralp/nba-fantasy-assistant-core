import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectPreparation } from '../../src/application/workspaceCommands.ts';
import { WorkspaceStore } from '../../src/application/workspaceStore.ts';
import { LocalStorageWorkspaceRepository, WORKSPACE_STORAGE_KEY as key } from '../../src/infrastructure/persistence/localStorageWorkspaceRepository.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { draftStatus } from '../../src/application/draftSelectors.ts';
import { settingsFromWorkspace, applyLeagueSettings } from '../../src/application/leagueSetup.ts';
import { restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { migrateLegacyV3Json } from '../../src/infrastructure/persistence/legacyV3.ts';
import { fresh } from '../helpers/draftFixture.ts';

const ready = () => { const w = fresh(3); return applyDraftCommand(w, {kind:'strategy', targets:{...w.strategies[0].targets, PTS:'top3'}}); };
function setup(w = ready()) {
  const data = new Map([[key, JSON.stringify(w)], ['unrelated', 'keep']]);
  const storage = {getItem: (k: string) => data.get(k) ?? null, setItem: (k: string,v: string) => {data.set(k,v);}, removeItem: (k: string) => {data.delete(k);} };
  const store = new WorkspaceStore(new LocalStorageWorkspaceRepository(() => storage));
  return {data, storage, store};
}
test('own team selection derives position exclusively from draftOrder and keeps snake order', () => {
  const w = ready(), settings = settingsFromWorkspace(w);
  for (let i = 0; i < 10; i++) {
    const result = applyLeagueSettings({...settings, userTeamId: settings.draftOrder[i]}, w); assert.ok(result.ok);
    assert.equal(draftStatus(result.value).userPosition, i + 1);
    assert.deepEqual(result.value.draftSession?.draftOrder, w.draftSession?.draftOrder);
  }
});
test('three preparation steps require league, an active target, and an active dataset; punt alone is incomplete', () => {
  assert.equal(selectPreparation(null).canOpen, false);
  const w = fresh(0); assert.equal(selectPreparation(w).strategy, false); assert.equal(selectPreparation(w).canOpen, false);
  assert.equal(selectPreparation(applyDraftCommand(w,{kind:'strategy',targets:{...w.strategies[0].targets,PTS:'punt'}})).strategy,false);
  assert.equal(selectPreparation(ready()).ready,true);
  assert.equal(selectPreparation({...ready(),league:{...ready().league,activeDatasetId:null}}).canOpen,false);
  assert.equal(selectPreparation({...ready(),league:{...ready().league,userTeamId:null}}).league,false);
});
test('existing native records and migrated v3 derive readiness without schema changes', () => {
  const native = restoreWorkspaceJson(JSON.stringify(ready())); assert.ok(native.ok); assert.equal(selectPreparation(native.value).ready,true);
  const legacy = migrateLegacyV3Json(readFileSync(new URL('../fixtures/persistence/v3-backup.json',import.meta.url),'utf8'),{leagueId:'old',season:'2026-27',importedAt:'2026-10-20T00:00:00Z',confirmUnverifiableTurns:true});
  assert.ok(legacy.ok); assert.equal(selectPreparation(legacy.value.snapshot).hasDraft,true); assert.equal(selectPreparation(legacy.value.snapshot).canOpen,true);
});
test('strategy reset only unsets own nine targets and preserves draft and other strategies verbatim', async () => {
  const w = applyDraftCommand(ready(),{kind:'assign',playerId:'p0',teamId:'t0'}), {store} = setup(w); await store.load(); const before = store.getSnapshot().workspace!;
  assert.equal(store.resetPreparation('strategy',false,0),false); assert.equal(store.resetPreparation('strategy',true,99),false);
  assert.equal(store.resetPreparation('strategy',true,0),true); const next = store.getSnapshot().workspace!;
  assert.ok(Object.values(next.strategies.find(s=>s.teamId==='t0')!.targets).every(t=>t==='unset'));
  assert.deepEqual(next.strategies.filter(s=>s.teamId!=='t0'),before.strategies.filter(s=>s.teamId!=='t0')); assert.equal(next.draftSession,before.draftSession);
  assert.equal(next.projections,before.projections); assert.equal(selectPreparation(next).canOpen,true); assert.equal(selectPreparation(next).strategy,false);
  assert.equal(store.getSnapshot().dirty,true);
});
test('pool reset removes active dataset reference while keeping picks, identities, ownership and historical data', async () => {
  const w = applyDraftCommand(ready(),{kind:'assign',playerId:'p0',teamId:'t0'}), {store,data} = setup(w); await store.load(); const before = store.getSnapshot().workspace!;
  assert.equal(store.resetPreparation('pool',true,0),true); const next = store.getSnapshot().workspace!;
  assert.equal(next.league.activeDatasetId,null);
  for(const k of ['players','datasets','projections','eligibility','strategies','draftSession'] as const) assert.equal(next[k],before[k]);
  assert.equal(selectPreparation(next).canOpen,true); assert.equal(selectPreparation(next).pool,false);
  assert.equal(JSON.parse(data.get(key)!).league.activeDatasetId,'data'); await store.save(); assert.equal(JSON.parse(data.get(key)!).league.activeDatasetId,null);
});
test('league reset requires explicit consent, current revision and clears only owned storage after success', async () => {
  const {store,data} = setup(); await store.load();
  assert.equal(await store.resetLeague(false,0),false); assert.equal(await store.resetLeague(true,1),false); assert.ok(data.has(key));
  assert.equal(await store.resetLeague(true,0),true); assert.equal(store.getSnapshot().workspace,null); assert.equal(store.getSnapshot().dirty,false);
  assert.equal(data.has(key),false); assert.equal(data.get('unrelated'),'keep');
});
for (const failure of ['SecurityError','QuotaExceededError']) test(`league deletion ${failure} preserves both memory and stored data`, async () => {
  const {store,data,storage} = setup(); await store.load(); store.accept(ready()); const before = store.getSnapshot(); const saved = data.get(key);
  storage.removeItem = () => {throw {name:failure};};
  assert.equal(await store.resetLeague(true,before.revision),false); assert.equal(store.getSnapshot().workspace,before.workspace); assert.equal(store.getSnapshot().dirty,true); assert.equal(data.get(key),saved);
});
test('reset cannot erase unseen, conflicting or corrupt records', async () => {
  const {store,data} = setup(); await store.load(); const before = store.getSnapshot().workspace;
  data.set(key,JSON.stringify({...ready(),league:{...ready().league,name:'other tab'}}));
  assert.equal(await store.resetLeague(true,0),false); assert.equal(store.getSnapshot().workspace,before); assert.equal(store.getSnapshot().conflict,true);
  assert.equal(store.resetPreparation('strategy',true,0),false);
  const broken = setup(); broken.data.set(key,'{'); await broken.store.load(); broken.store.accept(ready());
  assert.equal(await broken.store.resetLeague(true,1),false); assert.equal(broken.data.get(key),'{'); assert.ok(broken.store.getSnapshot().workspace);
});
test('async deletion blocks every mutation and save until it completes', async () => {
  let release!: (v: {ok:true;value:undefined})=>void;
  const store = new WorkspaceStore({load:async()=>({ok:true,value:ready()}),save:async()=>{throw Error('must not save');},clear:()=>new Promise(r=>{release=r;})});
  await store.load(); const pending = store.resetLeague(true,0); assert.equal(store.getSnapshot().saving,true);
  assert.equal(store.accept(ready()),false); assert.equal(store.resetPreparation('pool',true,0),false); assert.equal(await store.resetLeague(true,0),false); await store.save();
  release({ok:true,value:undefined}); assert.equal(await pending,true);
});
