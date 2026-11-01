import { unifiedStandard, unifiedSchedule, legacyScenario } from '../helpers/unifiedScenario.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseScenarioSnapshot } from '../../src/projections/scenarioSnapshot.ts';
import { adaptCentralRos, parseAnalysisSchedule } from '../../src/seasonAnalysis/centralAdapter.ts';
import { analyzeLeague } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { applyCentralDataset } from '../../src/application/centralDataset.ts';
import { fresh } from '../helpers/draftFixture.ts';
import { exportWorkspaceJson, restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { validateWorkspace } from '../../src/domain/rules/invariants.ts';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const raw=legacyScenario,standard=unifiedStandard;

test('real ten-team snapshot: strict standard remains 4/10; explicit model scenario has 90 finite ranks/z',()=>{
 const schedule=parseAnalysisSchedule(unifiedSchedule),league=read('tests/fixtures/season-analysis/public-league-normalized.json');
 const scenario=parseScenarioSnapshot(raw,standard);
 const run=(r:unknown)=>{const s=adaptCentralRos(r,schedule);return analyzeLeague({...s,league,schedule,asOf:s.snapshot.asOf,dataUpdatedAt:s.snapshot.generatedAt,lineupPolicy:'daily-max-games'});};
 assert.equal(run(standard).coverage.completeTeams,4);
 const result=run(scenario.projection);assert.equal(result.coverage.completeTeams,10);assert.equal(result.coverage.rankedCategories,9);
 for(const [category,rows] of Object.entries(result.rankings)){
  assert.equal(rows.length,10);assert.ok(rows.every(r=>r.rank!==null&&Number.isFinite(r.powerScore)));
  assert.ok(category==='TO'?rows[0].projectedValue!<=rows[9].projectedValue!:rows[0].projectedValue!>=rows[9].projectedValue!);
 }
 const totals=result.teams[0].partialTotals;
 assert.equal(result.rankings['FG%'].find(r=>r.teamId===result.teams[0].teamId)?.projectedValue,100*totals.FGM/totals.FGA);
 assert.equal(result.rankings['FT%'].find(r=>r.teamId===result.teams[0].teamId)?.projectedValue,100*totals.FTM/totals.FTA);
});
test('scenario boundary rejects source revision drift, future role, duplicate/exact-ID mismatch and false release claims',()=>{
 for(const mutate of [(s:any)=>s.standardGeneratedAt='2026-10-24T00:00:00Z',(s:any)=>s.scientificGatesEnabled=true,(s:any)=>s.inputRevision.opportunityModelSHA256='invalid',(s:any)=>{const p=s.projection.players.find((p:any)=>p.rosGP>0);s.players[p.id].opportunityEvidence.count=null;},(s:any)=>s.projection.players[0].id='wrong',(s:any)=>{const p=Object.values(s.players).find((m:any)=>m.roleEvidence) as any;p.roleEvidence.observedAt='2026-10-26T00:00:00Z';},(s:any)=>s.projection.players.push(s.projection.players[0])]){
  const s=structuredClone(raw);mutate(s);assert.throws(()=>parseScenarioSnapshot(s,standard));
 }
 const uncertain=structuredClone(raw),p=uncertain.projection.players.find((p:any)=>p.rosGP>0),m=uncertain.players[p.id];
 p.rosGP=null;p.confidence='low';m.tier='extended';m.confidence='low';m.availability=null;m.opportunityEvidence.count=null;
 const preserved=parseScenarioSnapshot(uncertain,standard).projection.players.find(x=>x.id===p.id)!;
 assert.equal(preserved.rosGP,null);assert.deepEqual(preserved.stats,p.stats);
});
test('central Draft adapter applies explicit model source with units/provenance and strict backup roundtrip',()=>{
 const w=fresh(0);const base={...w,league:{...w.league,season:'2026-27',activeDatasetId:null},datasets:[]};
 const before=structuredClone(base);let id=0;
 const next=applyCentralDataset(base,'extended',raw,standard,()=>`scenario-${++id}`,'2026-10-25T16:00:00Z');
 assert.deepEqual(base,before);assert.deepEqual(next.strategies,base.strategies);assert.deepEqual(validateWorkspace(next),[]);
 assert.equal(next.datasets[0].provenance?.projectionMode,'extended');assert.equal(next.datasets[0].provenance?.horizon,'remaining-season');
 const player=next.players.find(p=>p.providerIds?.espn==='5142620')!, projection=next.projections.find(p=>p.playerId===player.id)!;
 assert.equal(projection.status,'valid');assert.ok(projection.presentation?.modelLabel?.includes('Düşük güven'));
 if(projection.status==='valid'){const row=raw.projection.players.find((p:any)=>p.id==='5142620');assert.equal(projection.gamesPlayed,row.rosGP);assert.deepEqual(projection.stats,Object.fromEntries(Object.keys(projection.stats).map(k=>[k,row.stats[k]])));}
 const json=exportWorkspaceJson(next);assert.ok(json.ok);const restored=restoreWorkspaceJson(json.value);assert.ok(restored.ok);assert.deepEqual(restored.value,next);
 assert.throws(()=>applyCentralDataset({...base,manualDraftLocked:true},'extended',raw,standard,()=>`x-${++id}`,'2026-10-25T16:00:00Z'),/kilitli/);
});
