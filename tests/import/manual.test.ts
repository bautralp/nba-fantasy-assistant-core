import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import type { RawFile } from '../../src/application/projectionRows.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareManualImport, applyManualImport, normalizeManualFile } from '../../src/application/manualImport.ts';
import { createWorkbook, readWorkbook } from '../../src/infrastructure/projections/workbook.ts';
import { readCsv, readProjectionJson } from '../../src/infrastructure/projections/textReaders.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { WorkspaceStore } from '../../src/application/workspaceStore.ts';
import { LocalStorageWorkspaceRepository, WORKSPACE_STORAGE_KEY } from '../../src/infrastructure/persistence/localStorageWorkspaceRepository.ts';
import { restoreWorkspaceJson, exportWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
const key = 'nba-fantasy-assistant.session.v1';
const headers = ['PLAYER','POS','RANK','GP','FGM','FGA','FTM','FTA','3PM','PTS','REB','AST','STL','BLK','TO'];
const row = (name = 'Nikola Jokic', rank = 1) => [name,'C',rank,65,5,10,3,4,2,20,5,3,1,1,2];
const fresh = (): WorkspaceSnapshot => { const w = createInitialWorkspace({ leagueId: 'l', season: '2026-27', teamIds: Array.from({length:10}, (_, i) => `t${i}`), draftSessionId:'d' }); return {...w, league:{...w.league,name:'League',userTeamId:'t0'},teams:w.teams.map((t,i)=>({...t,name:`Team ${i}`}))}; };
let n = 0; const id = () => `independent-${++n}`;
const raw = (rows: unknown[][] = [row()]): RawFile => ({ name:'players.csv',format:'csv' as const,headers,rows,season:'2026-27',unit:'perGame' });
function load(w: WorkspaceSnapshot = fresh(), file: RawFile = raw()) { const p = prepareManualImport(file,{},w,0,id,'2026-10-21T00:00:00Z'); return applyManualImport(p,w,0); }
const settle = async (store: WorkspaceStore) => { while (store.getSnapshot().saving) await new Promise(r => setTimeout(r,0)); };
for(const format of ['xlsx','csv','json']) test(`${format} without PLAYER_ID imports with independent IDs and exact stats`,()=>{
 const file = format==='xlsx' ? readWorkbook(createWorkbook('2026-27','perGame',[row()]),'p.xlsx') : format==='csv' ? readCsv([headers.join(';'),row().join(';')].join('\n'),'p.csv') : readProjectionJson(JSON.stringify({season:'2026-27',unit:'perGame',players:[Object.fromEntries(headers.map((h,i)=>[h,row()[i]]))]}),'p.json');
 const w=fresh(),p=prepareManualImport(file,{season:'2026-27',unit:'perGame'},w,0,id,'2026-10-21T00:00:00Z'),next=applyManualImport(p,w,0);
 assert.match(next.players[0].id,/independent/); assert.equal(next.players[0].name,'Nikola Jokic'); assert.equal(next.projections[0].status,'valid'); if(next.projections[0].status==='valid') assert.equal(next.projections[0].stats.PTS,20);
});
test('new template and Instructions contain no PLAYER_ID or sample players',()=>{const p=readWorkbook(createWorkbook('2026-27','perGame'),'p.xlsx');assert.deepEqual(p.headers,headers);assert.deepEqual(p.rows,[]);});
test('IDs are unique, stable during preview/apply, independent of RANK and regenerated for independent work',()=>{
 const w=fresh(),p=prepareManualImport(raw([row(),row('Other',2)]),{},w,0,id,'2026-10-21T00:00:00Z');
 const changed={...p,rows:p.rows.map(r=>({...r,data:{...r.data,rank:99}}))}; const a=applyManualImport(p,w,0),b=applyManualImport(changed,w,0);
 assert.deepEqual(a.players.map(p=>p.id),b.players.map(p=>p.id)); assert.equal(new Set(a.players.map(p=>p.id)).size,2);assert.notEqual(load().players[0].id,a.players[0].id);
});
for(const name of [' NIKOLA JOKIC ', 'Nikola Jokić','Nikola-Jokic']) test(`normalized duplicate ${name} is rejected even with different RANK and legacy IDs`,()=>{
 const f=raw([row(),row(name,77)]); assert.throws(()=>normalizeManualFile({...f,headers:['PLAYER_ID',...headers],rows:f.rows.map((r,i)=>[i+1,...r])}),/Mükerrer oyuncu.*satır 2 ve 3/);
});
test('legacy PLAYER_ID is ignored including malformed and repeated IDs; no provider mapping is stored',()=>{
 const f=raw([row(),row('Other',2)]), w=load(fresh(),{...f,headers:['PLAYER_ID',...headers],rows:f.rows.map(r=>[false,...r])});
 assert.equal(new Set(w.players.map(p=>p.id)).size,2);assert.ok(w.players.every(p=>!p.providerIds));
});
test('metadata, season, unit and statistic validation stay enforced',()=>{
 assert.throws(()=>load(fresh(),{...raw(),season:'wrong'}),/sezon/);assert.throws(()=>normalizeManualFile({...raw(),unit:'unknown'}),/birimi/);
 const r=row();r[4]=100;const w=load(fresh(),raw([r]));assert.equal(w.projections[0].status,'excluded');
});
test('preparation replacement keeps exactly one dataset and no identity from the previous file',()=>{
 const a=load(),b=load(a,raw([row('Other')]));assert.equal(b.datasets.length,1);assert.equal(b.players.length,1);assert.notEqual(a.players[0].id,b.players[0].id);
});
test('stale preview and any import into a locked or picked draft are rejected',()=>{
 const w=fresh(),p=prepareManualImport(raw(),{},w,0,id,'2026-10-21T00:00:00Z');assert.throws(()=>applyManualImport(p,w,1),/yeniden/);
 const a=load();assert.throws(()=>load({...a,manualDraftLocked:true}),/kilitli/); const picked=applyDraftCommand(a,{kind:'assign',playerId:a.players[0].id,teamId:'t0'});assert.throws(()=>load(picked),/kilitli/);
});
function storage() {const data=new Map<string,string>([[WORKSPACE_STORAGE_KEY,'old local record']]);return {data,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};}
test('session autosaves league, UUIDs, targets and picks, reloads exactly and locks before first pick',async()=>{
 const s=storage(),store=new WorkspaceStore(new LocalStorageWorkspaceRepository(()=>s,key),true);await store.load();assert.ok(store.accept(load()));await settle(store);
 let w=store.getSnapshot().workspace!;w=applyDraftCommand(w,{kind:'strategy',targets:{...w.strategies[0].targets,PTS:'top3'}});assert.ok(store.accept(w));await settle(store);
 assert.equal(store.getSnapshot().workspace!.manualDraftLocked,true); assert.equal(store.getSnapshot().workspace!.draftSession!.picks.length,0); assert.equal(store.resetPreparation('pool',true,store.getSnapshot().revision),false);
 w=store.getSnapshot().workspace!;assert.ok(store.accept(applyDraftCommand(w,{kind:'assign',playerId:w.players[0].id,teamId:'t0'})));await settle(store);
 const reloaded=new WorkspaceStore(new LocalStorageWorkspaceRepository(()=>s,key),true);await reloaded.load();assert.deepEqual(reloaded.getSnapshot().workspace,store.getSnapshot().workspace);assert.equal(s.data.get(WORKSPACE_STORAGE_KEY),'old local record');
 assert.ok(store.accept(applyDraftCommand(store.getSnapshot().workspace!,{kind:'undo',playerId:store.getSnapshot().workspace!.players[0].id})));await settle(store);assert.equal(store.getSnapshot().workspace!.manualDraftLocked,true);
});
for(const error of ['QuotaExceededError','SecurityError']) test(`${error} on autosave retains current memory and portable JSON without claiming success`,async()=>{
 const s=storage(),store=new WorkspaceStore(new LocalStorageWorkspaceRepository(()=>s,key),true);await store.load();s.setItem=()=>{throw new DOMException('test',error);};const w=load();assert.ok(store.accept(w));await settle(store);
 assert.deepEqual(store.getSnapshot().workspace,w);assert.ok(store.getSnapshot().dirty);assert.ok(store.getSnapshot().error);assert.match(store.getSnapshot().message,/Kaydedilemedi/);const encoded=exportWorkspaceJson(w);assert.ok(encoded.ok);if(encoded.ok)assert.deepEqual(restoreWorkspaceJson(encoded.value),{ok:true,value:w});
});
test('new work requires confirmation and matching revision, deletes only active session; failed delete preserves memory',async()=>{
 const s=storage(),store=new WorkspaceStore(new LocalStorageWorkspaceRepository(()=>s,key),true);await store.load();store.accept(load());await settle(store);const {revision,workspace}=store.getSnapshot();assert.equal(await store.resetLeague(false,revision),false);assert.equal(await store.resetLeague(true,revision-1),false);
 const remove=s.removeItem;s.removeItem=()=>{throw new Error('denied');};assert.equal(await store.resetLeague(true,revision),false);assert.deepEqual(store.getSnapshot().workspace,workspace);s.removeItem=remove;assert.ok(await store.resetLeague(true,revision));assert.equal(store.getSnapshot().workspace,null);assert.equal(s.getItem(key),null);assert.equal(s.getItem(WORKSPACE_STORAGE_KEY),'old local record');
});

