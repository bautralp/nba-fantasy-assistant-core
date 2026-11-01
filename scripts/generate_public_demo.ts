/** Independently authored deterministic demo. No provider/history/network reads. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { rankProjections, parseProjections } from '../src/features/rankings/rosProjection.ts';
import { parseScenarioSnapshot } from '../src/projections/scenarioSnapshot.ts';
import { parseAnalysisSchedule, adaptCentralRos } from '../src/seasonAnalysis/centralAdapter.ts';
const stamp='2026-11-01T10:00:00Z',asOf='2026-11-01';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const provenance={kind:'synthetic',generator:'scripts/generate_public_demo.ts',notice:'Sentetik demo; gerçek ESPN/NBA gözlemi, lig veya tahmin değildir.'};
const games=Array.from({length:8},(_,i)=>({id:String(900000+i),date:`2026-11-${String(i+2).padStart(2,'0')}`,teamIds:[1,2]}));
const schedule={schemaVersion:1,seasonId:2027,asOf,through:'2026-11-09',retrievedAt:stamp,source:{url:'https://example.invalid/public-core/schedule.json',sha256:hash(games)},scope:'observed-regular-season',games,provenance};
const slots=[[0,5,11,12,13],[1,5,11,12,13],[2,6,11,12,13],[3,6,11,12,13],[4,11,12,13]];
const players=Array.from({length:220},(_,i)=>{
 const id=String(900001+i),pos=(['PG','SG','SF','PF','C'] as const)[i%5],teamId=1+i%2;
 const two=4+i%7,three=2+i%4,ft=2+i%3,p2=.4+(i%4)*.04,p3=.25+(i%5)*.04,pft=.6+(i%6)*.05;
 const fgm=two*p2+three*p3,fga=two+three,ftm=ft*pft;
 return {id,name:`Synthetic Player ${String(i+1).padStart(3,'0')}`,team:`SYN${teamId}`,teamId,positions:[pos],eligibility:{playerId:id,name:`Synthetic Player ${String(i+1).padStart(3,'0')}`,season:'2026-27' as const,positions:[pos],status:'verified' as const,provider:'Synthetic fixture',source:'https://example.invalid/public-core/eligibility.json',retrievedAt:stamp,proTeamId:teamId},
 status:'available' as const,reason:null,minutes:20+i%12,rosGP:6+i%3,teamRemaining:8,
 stats:{FGM:fgm,FGA:fga,FTM:ftm,FTA:ft,'3PM':three*p3,PTS:2*fgm+three*p3+ftm,REB:2+i%9,AST:1+i%7,STL:.2+(i%8)*.15,BLK:.1+(i%6)*.18,TO:.5+(i%5)*.3,'FG%':fgm/fga*100,'FT%':pft*100},
 shooting:{'2P':{attempts:two,percentage:p2},'3P':{attempts:three,percentage:p3},FT:{attempts:ft,percentage:pft}},
 role:{score:0,strength:0,labels:['synthetic'],teamChange:false,newTeamGames:0},confidence:'low' as const,uncertainty:['Sentetik demo; gerçek veri veya bilimsel tahmin değildir.'],injuryStatus:null,generatedAt:stamp,asOf,totalZ:null,rank:null};
});
const sources=[schedule.source,...['players','protocol','eligibility'].map(name=>({url:`https://example.invalid/public-core/${name}.json`,sha256:hash({name,provenance,ids:players.map(p=>p.id)})}))].map(s=>({...s,season:'synthetic'}));
const standard={...rankProjections({schemaVersion:1,modelVersion:1,season:'2026-27',kind:'projected-ros',unit:'perGame',asOf,generatedAt:stamp,refreshedAt:stamp,sources,positionReport:{verified:players.length,unresolved:0,mismatches:[]},players}),provenance};
const scenario={schemaVersion:1,kind:'extended-model-scenarios',modelVersion:'unified-ros/2',asOf,computedAt:stamp,sourceDataThrough:null,standardGeneratedAt:stamp,standardSources:standard.sources,projection:standard,scientificGatesEnabled:false,warnings:[provenance.notice],provenance,
 players:Object.fromEntries(standard.players.map(p=>[p.id,{tier:'standard',modelVersion:'synthetic-only/1',scientificAcceptance:false,confidence:'low',regularGP:2,preseasonGP:0,sourceConflict:false,sourceHistory:[],roleUse:{used:[]},availability:null,roleEvidence:null,opportunityEvidence:{modelVersion:'dated-team-opportunities/1',observedGP:2,count:2}}])),
 inputRevision:{...Object.fromEntries(['roleEvidenceSHA256','standardSHA256','rookieParametersSHA256','modelArtifactsSHA256','scenarioConfigSHA256','historySHA256','rookieProfilesSHA256','opportunityModelSHA256'].map(k=>[k,hash(k==='standardSHA256'?standard:{synthetic:true,key:k})])),returningParametersVersion:'synthetic-only/1',teamPeriodsSHA256:null}};
const league={id:789,seasonId:2027,scoringPeriodId:1,status:{currentMatchupPeriod:1},provenance,
 settings:{name:'Sentetik Demo Ligi',isPublic:true,scoringSettings:{scoringType:'H2H_MOST_CATEGORIES',allowOutOfPositionScoring:false,scoringItems:[19,20,17,6,3,2,1,11,0].map(statId=>({statId,points:1,isReverseItem:statId===11}))},rosterSettings:{lineupLocktimeType:'INDIVIDUAL_GAME',rosterLocktimeType:'FIRSTGAME_SCORINGPERIOD',lineupSlotStatLimits:{},lineupSlotCounts:{0:1,1:1,2:1,3:1,4:1,11:3,12:2,13:1}}},
 teams:Array.from({length:10},(_,i)=>({id:i+1,name:`Sentetik Takım ${i+1}`,record:{overall:{wins:i,losses:10-i,ties:0}},roster:{entries:players.slice(i*10,i*10+10).map((p,j)=>({playerId:Number(p.id),lineupSlotId:j<5?j:j<8?11:12,playerPoolEntry:{player:{id:Number(p.id),fullName:p.name,proTeamId:p.teamId,defaultPositionId:1+(i*10+j)%5,eligibleSlots:slots[(i*10+j)%5]}}}))}})),schedule:[]};
const pool={provenance,players:players.slice(100).map((p,i)=>({id:Number(p.id),onTeamId:0,status:i%3?'FREEAGENT':'WAIVERS',player:{id:Number(p.id),fullName:p.name,proTeamId:p.teamId,eligibleSlots:slots[(100+i)%5],defaultPositionId:1+(100+i)%5,injuryStatus:'ACTIVE',ownership:{percentOwned:Math.max(0,90-i/2)}}}))};
// Strict production gates stay strict; only the explicit synthetic parser option accepts this schedule.
parseProjections(standard);parseScenarioSnapshot(scenario,standard);adaptCentralRos(standard,parseAnalysisSchedule(schedule,{allowSynthetic:true}));
const outputs:Record<string,unknown>={'data/player-projections.json':standard,'data/projection-scenarios.json':scenario,'data/analysis-schedule.json':schedule,'data/projection-refresh-status.json':{schemaVersion:1,attemptedAt:stamp,status:'ok',errors:[],provenance},'league.json':league,'pool.json':pool};
mkdirSync('public/demo/data',{recursive:true});
for(const [name,body] of Object.entries(outputs))writeFileSync('public/demo/'+name,JSON.stringify(body)+'\n');
writeFileSync('public/demo/provenance.json',JSON.stringify({provenance,stamp,files:Object.fromEntries(Object.entries(outputs).map(([k,v])=>[k,createHash('sha256').update(JSON.stringify(v)+'\n').digest('hex')]))},null,2)+'\n');
console.log('Generated independent synthetic demo: 220 players, 10 teams, 120 waiver candidates, 8 fictional games.');
