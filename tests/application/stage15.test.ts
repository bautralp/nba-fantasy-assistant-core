import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zeroGamePlayers, parseRosters } from '../../src/features/rankings/currentRosters.ts';
import { playerZScores } from '../../src/features/rankings/playerZScores.ts';
import { parseSnapshot } from '../../src/features/rankings/centralStats.ts';
import { normalizeFile } from '../../src/application/projectionRows.ts';
import { validateSnapshotData } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { fresh } from '../helpers/draftFixture.ts';
const raw=JSON.parse(readFileSync('public/data/player-stats.json','utf8'));
const roster=JSON.parse(readFileSync('public/data/current-rosters.json','utf8'));
test('zero-GP display rows cannot change actual distributions, rank or totals; only exact verified IDs',()=>{
 const data=parseSnapshot(raw), r=parseRosters(roster), now=Date.parse(r.retrievedAt);
 for(const key of ['season','last7','last14','last30'] as const){
  const played=data.periods[key].players, before=playerZScores(played);
  const zero=zeroGamePlayers(played,r,now);
  assert.ok(zero.length>0);
  for(const p of zero){assert.equal(p.gp,0);assert.equal(p.mpg,0);assert.equal(p.stats['FG%'],null);assert.equal(p.stats['FT%'],null);assert.ok(Object.values(p.totals).every(v=>v===0));assert.ok(!played.some(v=>v.id===p.id));}
  assert.deepEqual(playerZScores(played),before);
  const sameNameDifferentId={...played[0],id:'not-the-roster-id',name:r.players[0].name};
  assert.ok(zeroGamePlayers([sameNameDifferentId],r,now).some(p=>p.id===r.players[0].id), 'same name never joins different ESPN IDs');
 }
 assert.equal(zeroGamePlayers([],r,now+37*3600000).length,0);
 assert.equal(zeroGamePlayers([],r,now-3600000).length,0);
});
test('MPG is optional for old snapshots but malformed MPG is rejected',()=>{
 const old=structuredClone(raw);for(const p of Object.values(old.periods) as any[])for(const r of p.players)delete r.mpg;
 assert.ok(parseSnapshot(old));for(const value of [-1,NaN,'20']){const v=structuredClone(raw);v.periods.season.players[0].mpg=value;assert.throws(()=>parseSnapshot(v));}
});
test('presentation metadata survives backup shape validation, engine fields and old sessions remain valid',()=>{
 const w=fresh(2);assert.ok(validateSnapshotData(w).ok);
 const p={...w.projections[0],presentation:{team:'BOS',mpg:32.5}};
 const next={...w,projections:[p,...w.projections.slice(1)]};const result=validateSnapshotData(next);assert.ok(result.ok);if(result.ok)assert.deepEqual(result.value,next);
 assert.equal(validateSnapshotData({...next,projections:[{...p,presentation:{mpg:-1}}]}).ok,false);
});
test('optional manual TEAM/MPG never inferred when absent',()=>{
 const headers=['PLAYER','GP','FGM','FGA','FTM','FTA','3PM','PTS','REB','AST','STL','BLK','TO'];
 const rows=[['Player',60,1,2,1,2,1,10,2,2,1,1,1]];
 const base={name:'test.csv',format:'csv' as const,headers,rows,season:'2026-27',unit:'perGame'};
 assert.equal(normalizeFile(base).rows[0].presentation,undefined);
 const file=normalizeFile({...base,headers:[...headers,'TEAM','MPG'],rows:[[...rows[0],'BOS',30]]});assert.deepEqual(file.rows[0].presentation,{team:'BOS',mpg:30});
});
