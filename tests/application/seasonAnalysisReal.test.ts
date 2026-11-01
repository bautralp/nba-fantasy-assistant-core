import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { analyzeLeague } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { adaptCentralRos, parseAnalysisSchedule } from '../../src/seasonAnalysis/centralAdapter.ts';
import { CATEGORIES } from '../../src/seasonAnalysis/model.ts';
import type { PublicLeague, LeaguePlayer } from '../../src/features/season/model.ts';
import { PROJECTION_STATS } from '../../src/domain/models/projection.ts';
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('real ESPN roster + central ROS + exact schedule: independent exhaustive lineup oracle verifies all nine category totals', () => {
  const league = read('../fixtures/season-analysis/public-league-normalized.json') as PublicLeague;
  const pinned = read('../fixtures/season-analysis/real-analysis-input.json') as Omit<import('../../src/seasonAnalysis/model.ts').AnalysisInput, 'league' | 'lineupPolicy'>;
  const schedule = pinned.schedule!;
  const input = { league, ...pinned, lineupPolicy: 'daily-max-games' as const };
  const result = analyzeLeague(input);
  const projection = new Map(pinned.projections.map(p => [p.espnId, p]));
  const slots = league.rosterSlots.filter(s => s.slotId <= 11).flatMap(s => Array<number>(s.count).fill(s.slotId));
  // Deliberately independent algorithm: enumerate subsets in descending cardinality,
  // then solve feasibility by recursively assigning the most constrained player.
  function feasible(players: LeaguePlayer[], remaining: number[]): boolean {
    if (!players.length) return true;
    const sorted = [...players].sort((a,b) => remaining.filter(s => a.eligibleSlotIds!.includes(s)).length - remaining.filter(s => b.eligibleSlotIds!.includes(s)).length);
    const [first, ...rest] = sorted;
    for (let i=0;i<remaining.length;i++) if (first.eligibleSlotIds!.includes(remaining[i]) && feasible(rest, remaining.filter((_,j)=>j!==i))) return true;
    return false;
  }
  function* subsets<T>(items: T[], count: number, start=0, chosen: T[]=[]): Generator<T[]> {
    if (!count) { yield chosen; return; }
    for(let i=start;i<=items.length-count;i++) yield* subsets(items,count-1,i+1,[...chosen,items[i]]);
  }
  const report: unknown[]=[];
  for(const team of result.teams.filter(t=>t.complete)) {
    const roster=league.teams.find(t=>t.espnTeamId===team.teamId)!.roster!.filter(p=>p.placement!=='ir');
    const counts=new Map<number,number>();
    const dates=[...new Set(schedule.games.map(g=>g.date))];
    for(const date of dates) {
      const nba=new Set(schedule.games.filter(g=>g.date===date).flatMap(g=>g.teamIds));
      const playing=roster.filter(p=>nba.has(p.proTeamId!) && projection.get(p.espnPlayerId)!.expectedGames!>0).sort((a,b)=>Number(b.placement==='active')-Number(a.placement==='active')||a.espnPlayerId-b.espnPlayerId);
      let lineup:LeaguePlayer[]=[];
      outer: for(let size=Math.min(slots.length,playing.length);size>=0;size--) for(const subset of subsets(playing,size)) if(feasible(subset,slots)){lineup=subset;break outer;}
      for(const p of lineup) counts.set(p.espnPlayerId,(counts.get(p.espnPlayerId)??0)+1);
    }
    const totals=Object.fromEntries(PROJECTION_STATS.map(k=>[k,0])) as Record<typeof PROJECTION_STATS[number],number>;
    for(const p of roster) {
      const row=projection.get(p.espnPlayerId)!;
      const games=(counts.get(p.espnPlayerId)??0)*row.expectedGames!/row.teamRemaining!;
      for(const key of PROJECTION_STATS) totals[key]+=row.stats![key]*games;
      assert.equal(team.contributions.find(c=>c.espnId===p.espnPlayerId)!.selectedGames,counts.get(p.espnPlayerId)??0);
    }
    const numeric=Object.fromEntries(CATEGORIES.map(c=>[c,c==='FG%'?100*totals.FGM/totals.FGA:c==='FT%'?100*totals.FTM/totals.FTA:totals[c]]));
    for(const c of CATEGORIES) {
      const value=result.rankings[c].find(r=>r.teamId===team.teamId)!.projectedValue;
      assert.ok(value!==null && Math.abs(value-numeric[c])<1e-8,`${team.teamId} ${c}: ${value} != ${numeric[c]}`);
    }
    report.push({teamId:team.teamId,coverage:team.coverage,oracleValues:numeric});
  }
  assert.ok(report.length>0,'Real input needs at least one complete team for independent numeric validation');
  if(result.teams.some(t=>!t.complete)) for(const c of CATEGORIES) assert.ok(result.rankings[c].every(r=>r.rank===null && r.powerScore===null));
  mkdirSync('artifacts/season-analysis',{recursive:true});writeFileSync('artifacts/season-analysis/real-validation.json',JSON.stringify({status:result.status,asOf:result.asOf,sourceRevision:result.sourceRevision,datasetRevision:result.datasetRevision,scheduleRevision:result.scheduleRevision,method:'Independent exhaustive subsets + recursive slot feasibility; no engine lineup code reused',verified:report,teamCoverage:result.teams.map(t=>({teamId:t.teamId,complete:t.complete,coverage:t.coverage,warnings:t.warnings}))},null,2)+'\n');
});
test('central source rejects Actual snapshot and stale schedule SHA/date instead of mixing revisions', () => {
 const schedule=parseAnalysisSchedule(read('../../public/data/analysis-schedule.json'));
 assert.throws(()=>adaptCentralRos(read('../../public/data/player-stats.json'),schedule));
 const raw=read('../../public/data/player-projections.json');
 assert.throws(()=>adaptCentralRos(raw,{...schedule,source:{...schedule.source,sha256:'0'.repeat(64)}}));
 assert.throws(()=>adaptCentralRos(raw,{...schedule,asOf:'2000-01-01'}));
});
