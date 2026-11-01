import test from 'node:test';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import assert from 'node:assert/strict';
import { fresh } from '../helpers/draftFixture.ts';
import { selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { calculateModel } from '../../src/engine/index.ts';

test('legacy unranked workspaces use the full unchanged engine model, independent of picks and strategy',()=>{
 let w:WorkspaceSnapshot={...fresh(140),projections:fresh(140).projections.map(({rank,...p})=>p)};
 const before=selectDraftWorkspace(w),expected=calculateModel(w.players,w.projections,w.datasets[0]);
 assert.deepEqual(before.model,expected);
 assert.equal(before.poolRanking.ranks.size,140);
 const ordered=[...before.poolRanking.ranks].sort((a,b)=>a[1]-b[1]);
 for(let i=1;i<ordered.length;i++) assert.ok(before.poolRanking.totalZ.get(ordered[i-1][0])!>=before.poolRanking.totalZ.get(ordered[i][0])!);
 w=applyDraftCommand(w,{kind:'assign',playerId:ordered[0][0],teamId:'t0'});
 w=applyDraftCommand(w,{kind:'strategy',targets:{...w.strategies[0].targets,PTS:'punt',REB:'top3'}});
 const after=selectDraftWorkspace(w);assert.deepEqual(after.poolRanking.ranks,before.poolRanking.ranks);assert.deepEqual(after.model,expected);
});
test('central API dataset source ranks retain their original gaps',()=>{
 const raw=fresh(4),w={...raw,datasets:raw.datasets.map(d=>({...d,source:{name:'Central snapshot',kind:'api' as const}})),projections:raw.projections.map((p,i)=>({...p,rank:10+i*3}))};
 const r=selectDraftWorkspace(w).poolRanking;assert.equal(r.source,'provided');assert.deepEqual([...r.ranks.values()],[10,13,16,19]);
});

test('API source ranks tolerate excluded omissions but never missing, partial or unusable valid-player ranks',()=>{
 const raw=fresh(4), dataset={...raw.datasets[0],source:{name:'API test pool',kind:'api' as const}};
 const excluded={playerId:'p3',datasetId:'data',status:'excluded' as const,reasons:['No projection']};
 const w:WorkspaceSnapshot={...raw,datasets:[dataset],projections:[...raw.projections.slice(0,3).map((p,i)=>({...p,rank:(i+1)*5})),excluded]};
 let r=selectDraftWorkspace(w).poolRanking;
 assert.equal(r.source,'provided');assert.deepEqual([...r.ranks.values()],[5,10,15]);assert.equal(r.ranks.has('p3'),false);
 for(const projections of [
  w.projections.map(({rank,...p})=>p),
  w.projections.map((p,i)=>i===1?(({rank,...rest})=>rest)(p):p),
  w.projections.map((p,i)=>i===1?{...p,rank:5}:p),
  w.projections.map((p,i)=>i===1?{...p,rank:0}:p),
 ]) {
  r=selectDraftWorkspace({...w,projections}).poolRanking;assert.equal(r.source,'automatic');assert.equal(r.ranks.size,3);assert.equal(r.ranks.has('p3'),false);
 }
});
