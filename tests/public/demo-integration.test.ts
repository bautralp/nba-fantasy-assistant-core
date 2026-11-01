import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseProjections} from '../../src/features/rankings/rosProjection.ts';
import {parseScenarioSnapshot} from '../../src/projections/scenarioSnapshot.ts';
import {parseAnalysisSchedule,adaptCentralRos} from '../../src/seasonAnalysis/centralAdapter.ts';
import {normalizeLeague} from '../../src/infrastructure/espn/normalize.ts';
import {analyzeLeague} from '../../src/seasonAnalysis/analyzeLeague.ts';
import {publicProviderFetch,datasetUrl} from '../../src/publicCore/dataAccess.ts';
const read=(name:string)=>JSON.parse(readFileSync(new URL('../../public/demo/'+name,import.meta.url),'utf8'));
const raw=read('data/player-projections.json'),schedule=read('data/analysis-schedule.json'),scenario=read('data/projection-scenarios.json'),league=read('league.json');
test('synthetic source digests, identities and shooting are independent and deterministic',()=>{
 const manifest=read('provenance.json');
 for(const [name,digest] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(new URL('../../public/demo/'+name,import.meta.url))).digest('hex'),digest);
 const parsed=parseProjections(raw);assert.equal(parsed.players.length,220);
 assert.ok(parsed.players.every(p=>p.name.startsWith('Synthetic Player ')&&Number(p.id)>=900001));
 assert.ok(parsed.sources.every(s=>new URL(s.url).hostname==='example.invalid'));
 for(const p of parsed.players){assert.ok(Math.abs(p.stats!.PTS-(2*p.stats!.FGM+p.stats!['3PM']+p.stats!.FTM))<1e-10);}
});
test('default schedule gate rejects synthetic provenance; explicit demo gate still rejects invalid identities',()=>{
 assert.throws(()=>parseAnalysisSchedule(schedule));
 assert.equal(parseAnalysisSchedule(schedule,{allowSynthetic:true}).games.length,8);
 for(const mutate of [(s:any)=>s.games[0].teamIds=[1,1],(s:any)=>s.games.push(s.games[0]),(s:any)=>s.source.url='https://evil.invalid/data',(s:any)=>delete s.provenance]){
  const invalid=structuredClone(schedule);mutate(invalid);assert.throws(()=>parseAnalysisSchedule(invalid,{allowSynthetic:true}));
 }
});
test('ten-team ROS/Power pipeline preserves all nine categories and rejects changed standard rows',()=>{
 const standard=parseProjections(raw);const extended=parseScenarioSnapshot(scenario,standard);
 const parsed=parseAnalysisSchedule(schedule,{allowSynthetic:true});const adapted=adaptCentralRos(extended.projection,parsed);
 const result=analyzeLeague({league:normalizeLeague(league,789,2027),...adapted,schedule:parsed,asOf:standard.asOf,dataUpdatedAt:standard.generatedAt,lineupPolicy:'daily-max-games'});
 assert.equal(result.status,'ready');assert.equal(result.coverage.rankedCategories,9);
 for(const rows of Object.values(result.rankings)){assert.equal(rows.length,10);assert.ok(rows.every(r=>Number.isFinite(r.projectedValue)));}
 const corrupt=structuredClone(scenario);corrupt.projection.players[0].rosGP=1;assert.throws(()=>parseScenarioSnapshot(corrupt,standard));
});
test('public default never calls live ESPN; path traversal and unknown data paths fail',async()=>{
 await assert.rejects(publicProviderFetch('https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/789'),/PUBLIC_CORE_LIVE_DATA_DISABLED/);
 assert.throws(()=>datasetUrl('/','../private.json'));assert.throws(()=>datasetUrl('/','private.json'));
});

test('anonymous waiver client pages an independent 240-player pool and caches exact results',async()=>{
 const {createWaiverPoolClient}=await import('../../src/infrastructure/espn/waiverPool.ts');
 const seed=read('pool.json').players;
 const players=Array.from({length:240},(_,i)=>{const row=structuredClone(seed[i%seed.length]);row.id=910001+i;row.player.id=row.id;row.player.fullName=`Synthetic Pool ${i}`;return row;});
 const offsets:number[]=[];
 const fetcher:typeof fetch=async(_input,init)=>{
  assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
  const headers=new Headers(init?.headers);assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
  const filter=JSON.parse(headers.get('x-fantasy-filter')!).players;offsets.push(filter.offset);assert.deepEqual(filter.filterStatus.value,['FREEAGENT','WAIVERS']);
  return Response.json({players:players.slice(filter.offset,filter.offset+filter.limit)},{headers:{'x-fantasy-filter-player-count':'240'}});
 };
 const client=createWaiverPoolClient({fetcher,pageGapMs:0});const result=await client.load(789,2027);
 assert.equal(result.players.length,240);assert.equal(result.completeness,'end-observed');assert.deepEqual(offsets,[0,200]);
 assert.equal(await client.load(789,2027),result);assert.deepEqual(offsets,[0,200]);
 const denied=createWaiverPoolClient({fetcher:async()=>new Response('{}',{status:403})});await assert.rejects(denied.load(789,2027),/anonim erişime kapalı/);
});
