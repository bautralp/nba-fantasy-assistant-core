import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADERS } from '../../src/application/projectionRows.ts';
import { prepareManualImport, applyManualImport } from '../../src/application/manualImport.ts';
import { selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { readCsv, readProjectionJson } from '../../src/infrastructure/projections/textReaders.ts';
import { createWorkbook, readWorkbook } from '../../src/infrastructure/projections/workbook.ts';
import { exportWorkspaceJson, restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';

const season='2026-27', now='2026-10-23T00:00:00Z';
const row=(name:string,rank:unknown,pts=20):unknown[]=>['ignored',name,'G',rank,60,5,10,3,4,2,pts,5,3,1,1,2];
const base=()=>createInitialWorkspace({leagueId:'l',season,teamIds:Array.from({length:10},(_,i)=>`t${i}`),draftSessionId:'d'});
function load(format:string, rows:unknown[][], prefix='uuid', omitRank=false) {
 const indices=HEADERS.map((_,i)=>i).filter(i=>!omitRank||HEADERS[i]!=='RANK');
 const headers=indices.map(i=>HEADERS[i]),cells=rows.map(r=>indices.map(i=>r[i]));
 const raw=format==='xlsx' ? readWorkbook(createWorkbook(season,'perGame',cells,headers),'test.xlsx') : format==='csv' ?
 readCsv([headers.join(';'),...cells.map(r=>r.join(';'))].join('\n'),'test.csv') : readProjectionJson(JSON.stringify({season,unit:'perGame',players:cells.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])))}),'test.json');
 let i=0; const w=base(), preview=prepareManualImport(raw,{season,unit:'perGame'},w,0,()=>`${prefix}-${i++}`,now);
 return {w:applyManualImport(preview,w,0),preview};
}
const byName=(w:ReturnType<typeof base>)=>Object.fromEntries(w.players.map(p=>[p.name,selectDraftWorkspace(w).poolRanking.ranks.get(p.id)??null]));
for(const format of ['csv','xlsx','json']) {
 for(const [label,ranks,source,issue] of [
  ['ordered',[1,2,3],'provided',null],['shuffled',[3,1,2],'provided',null],
  ['absent',['','',''],'automatic','missing'],['no-column',['','',''],'automatic','missing'],['partial',[8,'',2],'automatic','partial'],
  ['duplicate',[1,1,2],'automatic','duplicate'],['invalid',[1,'bad',3],'automatic','invalid'],
 ] as const) test(`${format}: ${label} source ranks select one consistent ranking`,()=>{
  const {w}=load(format,[row('Alpha',ranks[0],30),row('Beta',ranks[1],20),row('Gamma',ranks[2],10)],'uuid',label==='no-column');
  const originals=structuredClone(w.projections),r=selectDraftWorkspace(w).poolRanking;
  assert.equal(r.source,source);assert.equal(r.issue,issue);
  assert.deepEqual(byName(w),source==='provided'?{Alpha:ranks[0],Beta:ranks[1],Gamma:ranks[2]}:{Alpha:1,Beta:2,Gamma:3});
  assert.deepEqual(w.projections,originals,'source ranks are never overwritten with derived ranks');
  if(issue && issue!=='missing') assert.match(r.notice,/Kaynak RANK (geçersiz|mükerrer|kısmi)/);
  const exported=exportWorkspaceJson(w);assert.ok(exported.ok);
  const restored=restoreWorkspaceJson(exported.value);assert.ok(restored.ok);
  assert.deepEqual(byName(restored.value),byName(w));assert.equal(selectDraftWorkspace(restored.value).poolRanking.issue,issue);
 });
 test(`${format}: excluded players get no invented automatic rank`,()=>{
  const bad=row('Excluded', '',40);bad[4]=0;
  const {w}=load(format,[row('Alpha','',30),bad,row('Beta','',20)]);
  assert.deepEqual(byName(w),{Alpha:1,Excluded:null,Beta:2});
 });
}
test('equal TOTAL Z resolves by name, independently of row order and fresh UUIDs',()=>{
 const rows=[row('Zulu',''),row('Alpha',''),row('Beta','')];
 const a=load('json',rows,'first').w,b=load('json',[...rows].reverse(),'unrelated').w;
 assert.deepEqual(byName(a),{Zulu:3,Alpha:1,Beta:2});assert.deepEqual(byName(a),byName(b));
});
test('invalid source rank diagnosis survives strict backup and cannot contain arbitrary enum values',()=>{
 const {w}=load('csv',[row('Alpha',-1)]);assert.equal(w.datasets[0].rankInputIssue,'invalid');
 const text=exportWorkspaceJson(w);assert.ok(text.ok);
 const invalid=JSON.parse(text.value);invalid.datasets[0].rankInputIssue='untrusted';
 assert.equal(restoreWorkspaceJson(JSON.stringify(invalid)).ok,false);
});

for(const bad of [0,-1,1.5,'NaN','9007199254740992']) test(`invalid source rank ${bad} falls back without excluding valid statistics`,()=>{
 const {w}=load('json',[row('Alpha',bad,30),row('Beta',2,20)]);
 const v=selectDraftWorkspace(w);assert.equal(v.poolRanking.issue,'invalid');assert.equal(v.model?.valid.length,2);assert.deepEqual(byName(w),{Alpha:1,Beta:2});
});
