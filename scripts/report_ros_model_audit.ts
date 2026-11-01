/** Compare the pinned pre-fix league and current normalization without publishing data. */
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { analyzeLeague } from '../src/seasonAnalysis/analyzeLeague.ts';
import { adaptCentralRos, parseAnalysisSchedule } from '../src/seasonAnalysis/centralAdapter.ts';
import type { AnalysisInput } from '../src/seasonAnalysis/model.ts';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const pinned=read('tests/fixtures/season-analysis/real-analysis-input.json');
const league=read('tests/fixtures/season-analysis/public-league-normalized.json');
const before=analyzeLeague({...pinned,league,lineupPolicy:'daily-max-games'} as AnalysisInput);
const path=process.argv[2] || 'tests/fixtures/ros-model-audit/baseline-ros.json.gz';
const raw=path.endsWith('.gz')?JSON.parse(gunzipSync(fs.readFileSync(path)).toString()):read(path);
const schedule=parseAnalysisSchedule(pinned.schedule);
const {snapshot,...source}=adaptCentralRos(raw,schedule);
const after=analyzeLeague({...source,league,schedule,asOf:snapshot.asOf,dataUpdatedAt:snapshot.generatedAt,lineupPolicy:'daily-max-games'});
const changes=Object.fromEntries(Object.entries(after.rankings).map(([c,rows])=>[c,rows.map(r=>{
 const old=before.rankings[c as keyof typeof before.rankings].find(x=>x.teamId===r.teamId)!;
 return {teamId:r.teamId,before:old.projectedValue,after:r.projectedValue,delta:r.projectedValue===null||old.projectedValue===null?null:r.projectedValue-old.projectedValue,rank:r.rank,powerScore:r.powerScore};
})]));
fs.writeFileSync(process.argv[3] || 'docs/season/ros-model-audit/power-rankings-comparison.json',JSON.stringify({inputFile:path,asOf:after.asOf,modelVersion:after.modelVersion,beforeCompleteTeams:before.coverage.completeTeams,afterCompleteTeams:after.coverage.completeTeams,status:after.status,rankings:changes,teams:after.teams.map(t=>({teamId:t.teamId,complete:t.complete,coverage:t.coverage,warnings:t.warnings,zeroContributions:t.contributions.filter(c=>c.expectedGames===0)}))},null,2)+'\n');
console.log({before:before.coverage.completeTeams,after:after.coverage.completeTeams,status:after.status});
