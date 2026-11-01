import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchupCategories, categoryLeader, categoryValue, eligiblePositions, scheduleWeeks } from '../../src/features/season/leaguePresentation.ts';
import { normalizeLeague } from '../../src/infrastructure/espn/normalize.ts';
import { readFileSync } from 'node:fs';
import { teamPreferenceKey } from '../../src/features/season/navigation.ts';
const raw = () => JSON.parse(readFileSync(new URL('../fixtures/espn/category-response-shape.json', import.meta.url), 'utf8'));
test('weekly stats are provider cumulativeScore only; never season values, live alternative or daily points', () => {
 const r = raw(); r.schedule[0].home.cumulativeScore.scoreByStat = { 19: { score: .45 }, 11: { score: 0 }, 20: { score: null }, 17: {}  };
 r.schedule[0].home.cumulativeScoreLive = { scoreByStat: { 0: { score: 999 } } }; r.schedule[0].home.pointsByScoringPeriod = { 23: 400 };
 const league = normalizeLeague(r, 789, 2027); assert.deepEqual(league.matchups![0].home!.categoryStats, { 19: .45, 11: 0 });
 assert.deepEqual(scheduleWeeks(league), [4, 5]);
 league.matchups!.push({ ...league.matchups![0], matchupPeriodId: 2 }); assert.deepEqual(scheduleWeeks(league), [2, 4, 5]);
 assert.equal(league.scoringPeriodId, 23); assert.equal(league.matchupPeriodId, 4);
});
test('category percentage, lower TO, ties, missing and genuine zero are distinct', () => {
 assert.equal(categoryValue(.4567, 19), '45,67%'); assert.equal(categoryValue(.8, 20), '80,0%'); assert.equal(categoryValue(.375, 21), '37,5%'); assert.equal(categoryValue(0, 0), '0'); assert.equal(categoryValue(undefined, 11), 'Mevcut değil');
 assert.equal(categoryLeader(0, 3, 11), 'home'); assert.equal(categoryLeader(0, 3, 0), 'away'); assert.equal(categoryLeader(7, 7, 2), 'tie'); assert.equal(categoryLeader(undefined, 0, 2), null);
});
test('standings sentinel, final positive rank and playoff seed do not create a current rank', () => {
 const r = raw(); r.teams[1].rankCalculatedFinal = 1;
 const league = normalizeLeague(r, 789, 2027); assert.equal(league.teams[0].rank, null); assert.deepEqual(league.teams[0].record, { wins: 3, losses: 0, ties: 0 });
 // Retained v1 final-rank field is not used by StandingsScreen; no new current rank is inferred.
 assert.equal(league.teams[1].rank, 1); assert.equal(league.teams[1].record, null);
});
test('positions use only explicit eligible basketball slots; preferences isolate league and season', () => {
 const player = normalizeLeague(raw(), 789, 2027).teams[0].roster![0]; assert.equal(eligiblePositions(player), 'C');
 assert.equal(eligiblePositions({ ...player, displayPositions: [] }), 'Pozisyon bilinmiyor'); assert.equal(eligiblePositions({ ...player, displayPositions: [] }), 'Pozisyon bilinmiyor');
 assert.notEqual(teamPreferenceKey(789, 2027), teamPreferenceKey(789, 2026)); assert.notEqual(teamPreferenceKey(789, 2027), teamPreferenceKey(456, 2027));
});
test('category comparison takes the scoringItems subset for 9CAT, 8CAT and custom leagues; points/unknown/roto have no weekly table', () => {
 const r = raw(), nine = normalizeLeague(r, 789, 2027);
 assert.equal(matchupCategories(nine).length, 9);
 r.settings.scoringSettings.scoringItems = r.settings.scoringSettings.scoringItems.filter((c: { statId: number }) => c.statId !== 11);
 const eight = normalizeLeague(r, 789, 2027); assert.equal(matchupCategories(eight).length, 8); assert.ok(!matchupCategories(eight).some(c => c.statId === 11));
 r.settings.scoringSettings.scoringItems = [{ statId: 999, points: 1 }];
 const custom = normalizeLeague(r, 789, 2027); assert.deepEqual(matchupCategories(custom).map(c => c.label), ['ESPN stat 999']);
 assert.equal(categoryLeader(33, 22, 999), null); assert.equal(categoryLeader(33, 22, 999, true), 'away'); assert.equal(categoryLeader(33, 22, 999, false), 'home'); assert.equal(categoryLeader(undefined, 22, 999, false), null);
 assert.equal(categoryLeader(80, 90, 0, true), 'home'); assert.equal(categoryLeader(8, 10, 11, false), 'home');
 for (const type of ['H2H_POINTS', 'UNKNOWN', 'ROTO']) assert.deepEqual(matchupCategories({ ...nine, scoring: { ...nine.scoring, type } }), []);
 r.settings.scoringSettings.scoringItems = []; assert.deepEqual(matchupCategories(normalizeLeague(r, 789, 2027)), []);
});
