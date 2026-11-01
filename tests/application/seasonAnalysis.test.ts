import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLeague } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { selectDailyLineup } from '../../src/seasonAnalysis/lineup.ts';
import { CATEGORIES, type AnalysisInput, type AnalysisProjection } from '../../src/seasonAnalysis/model.ts';
import type { LeaguePlayer } from '../../src/features/season/model.ts';

const player = (id: number, eligible = [11], placement: LeaguePlayer['placement'] = 'active'): LeaguePlayer => ({ espnPlayerId: id, name: `P${id}`, proTeamId: 1, eligibleSlotIds: eligible, lineupSlotId: placement === 'ir' ? 13 : placement === 'bench' ? 12 : eligible[0], placement, primaryPosition: null, displayPositions: [] });
const projection = (id: number, n: number): AnalysisProjection => ({ espnId: id, nbaTeamId: 1, kind: 'ROS', unit: 'perGame', expectedGames: 2, teamRemaining: 2, warnings: [], stats: { FGM: n, FGA: Math.max(10, n), FTM: n, FTA: Math.max(10, n), '3PM': n, REB: n, AST: n, STL: n, BLK: n, TO: n, PTS: n } });
function fixture(n = 3): AnalysisInput {
  return { league: { schemaVersion: 1, provider: 'ESPN', leagueId: 99, seasonId: 2027, name: 'Synthetic mathematics fixture', visibility: 'public', fetchedAt: '2026-10-25T10:00:00Z', scoring: { type: 'H2H_MOST_CATEGORIES', analysisSupported: false, categories: CATEGORIES.map((label, statId) => ({ label, statId, points: 1, isReverse: label === 'TO' })) }, lineupRules: { lineupLocktimeType: 'INDIVIDUAL_GAME', rosterLocktimeType: 'FIRSTGAME_SCORINGPERIOD', hasGameLimits: false, allowOutOfPositionScoring: false }, rosterSlots: [{ slotId: 11, label: 'UTIL', count: 1 }, { slotId: 12, label: 'Bench', count: 1 }, { slotId: 13, label: 'IR', count: 1 }], scoringPeriodId: 1, matchupPeriodId: 1, matchups: null, teams: Array.from({ length: n }, (_, i) => ({ espnTeamId: i + 1, name: `T${i + 1}`, rank: 100 - i, record: { wins: 99 - i, losses: i, ties: 0 }, gamesBack: null, roster: [player(i + 1)] })) },
    projections: Array.from({ length: n }, (_, i) => projection(i + 1, i + 1)),
    schedule: { schemaVersion: 1, seasonId: 2027, asOf: '2026-10-25', through: '2026-10-27', retrievedAt: '2026-10-25T10:00:00Z', source: { url: 'test:synthetic', sha256: 'a'.repeat(64) }, scope: 'observed-regular-season', games: [{ id: '1', date: '2026-10-26', teamIds: [1, 2] }, { id: '2', date: '2026-10-27', teamIds: [1, 2] }] },
    asOf: '2026-10-25', dataUpdatedAt: '2026-10-25T10:00:00Z', datasetRevision: 'test-v1', lineupPolicy: 'daily-max-games' };
}
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
test('all nine categories: independently known values, ranks, sample z and positive neighboring gaps; standings ignored', () => {
  const r = analyzeLeague(fixture()); assert.equal(r.status, 'ready');
  for (const c of CATEGORIES) {
    const rows = r.rankings[c], reverse = c === 'TO';
    assert.deepEqual(rows.map(r => r.teamId), reverse ? [1, 2, 3] : [3, 2, 1]);
    assert.deepEqual(rows.map(r => r.rank), [1, 2, 3]);
    rows.forEach((row, i) => close(row.powerScore, 1 - i));
    const scale = c.includes('%') ? 10 : 2;
    close(rows[1].projectedValue, 2 * scale); close(rows[1].leaderGap, scale);
    close(rows[1].aboveGap, scale); close(rows[1].belowGap, scale);
    assert.equal(rows[0].aboveGap, null); assert.equal(rows[2].belowGap, null);
  }
});
test('FG/FT are ratios of weighted makes and attempts, never averaged player percentages', () => {
  const f = fixture(); f.league.rosterSlots[0].count = 2; f.league.teams[0].roster!.push(player(10));
  f.projections = [...f.projections, { ...projection(10, 1), expectedGames: 1, stats: { ...projection(10, 1).stats!, FGM: 9, FGA: 10, FTM: 4, FTA: 5 } }];
  const r = analyzeLeague(f); const t = r.teams[0];
  // 2*1 + 1*9 makes / (2*10 + 1*10) attempts, FT (2+4)/(20+5).
  close(r.rankings['FG%'].find(x => x.teamId === 1)!.projectedValue, 100 * 11 / 30);
  close(r.rankings['FT%'].find(x => x.teamId === 1)!.projectedValue, 24);
  close(t.coverage.expectedGames, 3);
});
test('competition ties 1,1,3 and nearest distinct group gaps', () => {
  const f = fixture(); f.projections = [projection(1, 3), projection(2, 3), projection(3, 1)];
  const rows = analyzeLeague(f).rankings.PTS; assert.deepEqual(rows.map(r => r.rank), [1, 1, 3]); close(rows[0].belowGap, 4); assert.equal(rows[1].aboveGap, null);
});
test('zero variance is finite z=0; zero attempts yields null, never fake 0%', () => {
  const f = fixture(); f.projections = f.projections.map(p => projection(p.espnId, 2));
  for (const c of CATEGORIES) assert.deepEqual(analyzeLeague(f).rankings[c].map(r => [r.rank, r.powerScore]), [[1, 0], [1, 0], [1, 0]]);
  f.projections = f.projections.map(p => ({ ...p, stats: { ...p.stats!, FGM: 0, FGA: 0, FTM: 0, FTA: 0 } }));
  const r = analyzeLeague(f); assert.equal(r.status, 'blocked'); assert.ok(r.rankings['FG%'].every(x => x.projectedValue === null && x.rank === null)); assert.ok(r.rankings.PTS.every(x => x.rank === 1));
});
for (const kind of ['unmatched', 'invalid', 'ambiguous'] as const) test(`${kind} ESPN ID blocks ranking without converting missing player to zero`, () => {
  const f = fixture();
  if (kind === 'unmatched') f.league.teams[0].roster![0].espnPlayerId = 999;
  if (kind === 'invalid') f.league.teams[0].roster![0].espnPlayerId = -1;
  if (kind === 'ambiguous') f.projections = [...f.projections, projection(1, 9)];
  const r = analyzeLeague(f); assert.equal(r.status, 'blocked'); assert.equal(r.rankings.PTS.find(x => x.teamId === 1)!.projectedValue, null); assert.ok(r.rankings.PTS.every(x => x.rank === null));
});
test('null/empty unloaded team blocks whole league comparisons; incomplete subset is not ranked', () => {
  for (const roster of [null, []]) { const f = fixture(); f.league.teams[0].roster = roster; assert.equal(analyzeLeague(f).status, 'blocked'); }
});
test('IR separately counted and excluded, even with no projection; never consumes active or bench capacity', () => {
  const f = fixture(); f.league.teams[0].roster!.push(player(100, [11], 'ir')); const r = analyzeLeague(f); assert.equal(r.status, 'ready'); close(r.rankings.PTS.find(x => x.teamId === 1)!.projectedValue, 2); assert.equal(r.teams[0].coverage.irPlayers, 1);
});
test('PG/SG/SF/PF/C and G/F/UTIL all use explicit ESPN eligible slots; flexible reassignment preserves specialists', () => {
  for (const id of [0, 1, 2, 3, 4, 5, 6, 11]) assert.deepEqual(selectDailyLineup([player(1, [id])], [id]), [1]);
  assert.deepEqual(selectDailyLineup([player(1, [0, 5]), player(2, [0])], [0, 5]).sort(), [1, 2]);
  assert.deepEqual(selectDailyLineup([player(1, [2, 6]), player(2, [2])], [2, 6]).sort(), [1, 2]);
});
test('position collision and bench limits: two centers cannot fill PG; bench contributes only on a selected day', () => {
  const f = fixture(); f.league.rosterSlots[0] = { slotId: 4, count: 1, label: 'C' }; f.league.rosterSlots.push({ slotId: 0, count: 1, label: 'PG' });
  for (const t of f.league.teams) t.roster = [player(t.espnTeamId, [4])];
  f.league.teams[0].roster!.push(player(10, [4], 'bench')); f.projections = [...f.projections, projection(10, 9)];
  const r = analyzeLeague(f); assert.equal(r.status, 'ready'); close(r.rankings.PTS.find(x => x.teamId === 1)!.projectedValue, 2); assert.equal(r.teams[0].contributions.find(x => x.espnId === 10)!.selectedGames, 0);
  // Bench has a different NBA schedule, so can fill the slot when the active center is off.
  f.league.teams[0].roster![1].proTeamId = 3;
  f.projections = f.projections.map(p => p.espnId === 10 ? { ...p, nbaTeamId: 3, teamRemaining: 1, expectedGames: 1 } : p);
  f.schedule!.games.push({ id: '3', date: '2026-10-28', teamIds: [3, 4] }); f.schedule!.through = '2026-10-28';
  close(analyzeLeague(f).rankings.PTS.find(x => x.teamId === 1)!.projectedValue, 11);
});
test('zero expected games excludes contribution without NaN; no games for a whole team blocks power', () => {
  const f = fixture(); f.league.teams[0].roster!.push(player(10)); f.projections = [...f.projections, { ...projection(10, 9), expectedGames: 0, stats: null }];
  const r = analyzeLeague(f); assert.equal(r.status, 'ready'); close(r.rankings.PTS.find(x => x.teamId === 1)!.projectedValue, 2);
  f.projections = f.projections.map(p => ({ ...p, expectedGames: 0 })); assert.equal(analyzeLeague(f).status, 'blocked');
});
test('remaining-total conversion equals per-game once, not twice; Actual mixed into ROS blocks', () => {
  const f = fixture(), expected = analyzeLeague(f);
  f.projections = f.projections.map(p => ({ ...p, unit: 'remainingTotal', stats: Object.fromEntries(Object.entries(p.stats!).map(([k, v]) => [k, v * p.expectedGames!])) as unknown as NonNullable<AnalysisProjection['stats']> }));
  assert.deepEqual(analyzeLeague(f).rankings.PTS, expected.rankings.PTS);
  f.projections = f.projections.map(p => ({ ...p, kind: 'Actual' })); assert.equal(analyzeLeague(f).status, 'blocked');
});
test('source/data/schedule/roster revisions invalidate, pure virtual rosters do not mutate ESPN source', () => {
  const f = fixture(), original = JSON.stringify(f), r = analyzeLeague(f);
  assert.equal(JSON.stringify(f), original); assert.equal(analyzeLeague(f).revision, r.revision);
  const virtual = structuredClone(f.league.teams); [virtual[0].roster, virtual[1].roster] = [virtual[1].roster, virtual[0].roster];
  assert.notEqual(analyzeLeague({ ...f, teams: virtual }).revision, r.revision); assert.equal(JSON.stringify(f), original);
  f.datasetRevision = 'v2'; assert.notEqual(analyzeLeague(f).revision, r.revision);
  f.league.fetchedAt = '2026-10-25T11:00:00Z'; assert.notEqual(analyzeLeague(f).sourceRevision, r.sourceRevision);
  f.schedule!.source.sha256 = 'b'.repeat(64); assert.notEqual(analyzeLeague(f).scheduleRevision, r.scheduleRevision);
});
test('valid leagues of 2, 6, 10, 12, 16 teams are not fixed to 10 or draft capacity 13', () => {
  for (const n of [2, 6, 10, 12, 16]) { const r = analyzeLeague(fixture(n)); assert.equal(r.status, 'ready'); assert.equal(r.rankings.PTS.length, n); assert.equal(r.rankings.PTS.at(-1)!.rank, n); }
});
test('missing schedule, season mismatch, unknown lock and game limits fail closed', () => {
  const f = fixture(); assert.equal(analyzeLeague({ ...f, schedule: null }).status, 'blocked');
  const empty = analyzeLeague({ ...f, teams: [] }); assert.equal(empty.status, 'blocked'); assert.equal(empty.coverage.rankedCategories, 0);
  assert.equal(analyzeLeague({ ...f, teams: [f.league.teams[0]] }).status, 'blocked');
  f.schedule!.seasonId = 2026; assert.equal(analyzeLeague(f).status, 'blocked'); f.schedule!.seasonId = 2027;
  f.league.lineupRules!.hasGameLimits = true; assert.equal(analyzeLeague(f).status, 'blocked');
  f.league.lineupRules = undefined; assert.equal(analyzeLeague(f).status, 'blocked');
});
