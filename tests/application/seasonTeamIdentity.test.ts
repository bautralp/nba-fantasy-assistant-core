import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { adaptCentralRos, parseAnalysisSchedule } from '../../src/seasonAnalysis/centralAdapter.ts';
import { analyzeLeague } from '../../src/seasonAnalysis/analyzeLeague.ts';
import type { PublicLeague } from '../../src/features/season/model.ts';
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const raw = () => JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/ros-model-audit/baseline-ros.json.gz', import.meta.url))).toString());
test('legacy exact-ID ESPN unassigned zero preserves performance but has zero current-assignment games', () => {
 const data=raw(), p=data.players.find((p:{id:string})=>p.id==='4397140');
 const result=adaptCentralRos(data,null).projections.find(p=>p.espnId===4397140)!;
 assert.equal(result.teamState,'unassigned');assert.equal(result.nbaTeamId,0);
 assert.equal(result.expectedGames,0);assert.equal(result.teamRemaining,0);
 assert.deepEqual(result.stats,p.stats);assert.ok(result.stats!.PTS>0);
});
test('unknown, unverified, contradictory or future team metadata cannot be promoted to verified zero', () => {
 for(const mutate of [
  (p: ReturnType<typeof raw>['players'][number])=>{p.eligibility.proTeamId=null;},
  (p: ReturnType<typeof raw>['players'][number])=>{p.eligibility.provider='Manual';},
  (p: ReturnType<typeof raw>['players'][number])=>{p.eligibility.retrievedAt='2099-01-01T00:00:00Z';},
  (p: ReturnType<typeof raw>['players'][number])=>{p.rosGP=1;p.teamRemaining=1;},
  (p: ReturnType<typeof raw>['players'][number])=>{p.teamIdentity={status:'assigned',teamId:15};},
 ]) {
  const data=raw();mutate(data.players.find((p:{id:string})=>p.id==='4397140'));
  const p=adaptCentralRos(data,null).projections.find(p=>p.espnId===4397140)!;
  assert.notEqual(p.teamState,'unassigned');assert.equal(p.nbaTeamId,null);
 }
});
test('real league remains 4/10 complete; verified zero removes only the team mismatch, never ignores missing rookies', () => {
 const league=read('../fixtures/season-analysis/public-league-normalized.json') as PublicLeague;
 const schedule=parseAnalysisSchedule(read('../fixtures/season-analysis/real-analysis-input.json').schedule);
 const {snapshot,...source}=adaptCentralRos(raw(),schedule);
 const result=analyzeLeague({league,schedule,...source,asOf:snapshot.asOf,dataUpdatedAt:snapshot.generatedAt,lineupPolicy:'daily-max-games'});
 assert.equal(result.coverage.completeTeams,4);assert.equal(result.status,'blocked');
 const team=result.teams.find(t=>t.teamId===5)!;
 const zero=team.contributions.find(c=>c.espnId===4397140)!;
 assert.equal(zero.expectedGames,0);assert.equal(zero.selectedGames,0);
 assert.ok(team.warnings.some(w=>w.includes('takım ataması yok')));
 assert.ok(team.warnings.some(w=>w.includes('5175737')));
 assert.ok(team.warnings.some(w=>w.includes('5254165')));
 for(const rows of Object.values(result.rankings))assert.ok(rows.every(r=>r.rank===null && r.powerScore===null));
});
