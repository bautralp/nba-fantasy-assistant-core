import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NINE_CATEGORIES } from '../../src/domain/models/categories.ts';
import { PROJECTION_STATS, type ProjectionStats } from '../../src/domain/models/projection.ts';
import { baseline, deviation, distribution, rawContributions } from '../../src/engine/categoryScores.ts';
import { selectReferencePool } from '../../src/engine/referencePool.ts';
import { playerZScores } from '../../src/features/rankings/playerZScores.ts';
import { parseSnapshot, periods, type StatsPlayer } from '../../src/features/rankings/centralStats.ts';

function player(id: string, overrides: Partial<ProjectionStats> = {}, gp = 1): StatsPlayer {
  const stats = { FGM: 5, FGA: 10, FTM: 3, FTA: 4, '3PM': 2, PTS: 15, REB: 5, AST: 4, STL: 1, BLK: 1, TO: 2, ...overrides };
  return { id, name: id, team: 'TEST', position: '', gp,
    totals: Object.fromEntries(PROJECTION_STATS.map(k => [k, stats[k] * gp])) as ProjectionStats,
    stats: { ...stats, 'FG%': stats.FGA ? stats.FGM / stats.FGA * 100 : null, 'FT%': stats.FTA ? stats.FTM / stats.FTA * 100 : null } };
}
const find = (result: ReturnType<typeof playerZScores>, id: string) => result.players.find(p => p.id === id)!;

test('all nine categories contribute with weight one; total is a sum', () => {
  const result = playerZScores([player('a'), player('b', { FGM: 8, FGA: 12, FTM: 5, FTA: 6, '3PM': 3, PTS: 25, REB: 7, AST: 8, STL: 2, BLK: 2, TO: 1 }), player('c', { PTS: 2, AST: 1 })]);
  assert.deepEqual(Object.keys(result.players[0]!.z), [...NINE_CATEGORIES]);
  for (const row of result.players) {
    assert.equal(row.totalZ, NINE_CATEGORIES.reduce((sum, c) => sum + row.z[c], 0));
    const raw = rawContributions(row.stats as ProjectionStats, result.baselines);
    for (const c of NINE_CATEGORIES) assert.equal(row.z[c], (raw[c] - result.means[c]) / result.deviations[c]);
  }
});
test('FG and FT reward volume at the same above-baseline percentage', () => {
  const r = playerZScores([player('low', { FGM: 3, FGA: 5, FTM: 4, FTA: 5 }), player('high', { FGM: 6, FGA: 10, FTM: 8, FTA: 10 }), player('below', { FGM: 1, FGA: 10, FTM: 1, FTA: 10 })]);
  for (const c of ['FG%', 'FT%'] as const) assert.ok(find(r, 'high').z[c] > find(r, 'low').z[c]);
});
test('turnovers are inverted and GP never scales per-game contributions', () => {
  const r = playerZScores([player('one', {}, 1), player('many', {}, 82), player('lowTO', { TO: 0 }), player('highTO', { TO: 5 })]);
  assert.deepEqual(find(r, 'one').z, find(r, 'many').z);
  assert.equal(find(r, 'one').totalZ, find(r, 'many').totalZ);
  assert.ok(find(r, 'lowTO').z.TO > 0); assert.ok(find(r, 'highTO').z.TO < 0);
});
test('two-pass pool matches engine on per-game inputs, caps at 130 and recalculates the reference distribution', () => {
  const players = Array.from({ length: 160 }, (_, i) => player(String(i).padStart(3, '0'), { PTS: i, AST: i % 11, TO: i % 7 }, i + 1));
  const inputs = players.map(p => ({ playerId: p.id, totals: { gamesPlayed: p.gp, stats: p.stats as ProjectionStats } }));
  const expected = selectReferencePool(inputs), result = playerZScores(players);
  assert.equal(result.referenceIds.length, 130);
  assert.deepEqual(result.referenceIds, expected.map(p => p.playerId));
  const b = baseline(expected.map(p => p.totals.stats));
  const dist = distribution(expected.map(p => rawContributions(p.totals.stats, b)));
  assert.deepEqual(result.baselines, b); assert.deepEqual(result.means, dist.means); assert.deepEqual(result.deviations, dist.deviations);
  assert.equal(result.players.length, 160);
  assert.deepEqual(playerZScores([...players].reverse()), result);
});
test('reference boundary and final ties are deterministic by ESPN ID', () => {
  const players = Array.from({ length: 140 }, (_, i) => player(String(i).padStart(3, '0'))).reverse();
  const result = playerZScores(players);
  assert.deepEqual(result.referenceIds, [...players].map(p => p.id).sort().slice(0, 130));
  assert.deepEqual(result.players.map(p => p.rank), Array.from({ length: 140 }, (_, i) => i + 1));
  assert.deepEqual(result, playerZScores([...players].reverse()));
});
test('ranking uses full precision before two-decimal display rounding', () => {
  const r = playerZScores([player('z', { PTS: 20.000001 }), player('a', { PTS: 20 }), player('b', { PTS: 1 })]);
  assert.equal(r.players[0]!.id, 'z');
  assert.equal(r.players[0]!.totalZ.toFixed(2), r.players[1]!.totalZ.toFixed(2));
  assert.ok(r.players[0]!.totalZ > r.players[1]!.totalZ);
});
test('empty, singleton, zero shooting volume and zero variance remain finite with engine sample SD fallback', () => {
  assert.equal(deviation([1, 2, 3]), 1); assert.equal(deviation([2, 4]), Math.sqrt(2));
  assert.deepEqual(playerZScores([]).players, []); assert.deepEqual(playerZScores([]).referenceIds, []);
  const zero = { FGM: 0, FGA: 0, FTM: 0, FTA: 0 };
  for (const players of [[player('one', zero)], [player('one', zero), player('two', zero)]]) {
    const r = playerZScores(players);
    assert.deepEqual(r.baselines, { fg: 0.47, ft: 0.78 });
    for (const row of r.players) { assert.equal(row.totalZ, 0); for (const z of Object.values(row.z)) assert.equal(z, 0); }
  }
});
test('all five periods independently derive distributions and ranks from their own players', () => {
  const snapshot = parseSnapshot(JSON.parse(readFileSync(new URL('../../public/data/player-stats.json', import.meta.url), 'utf8')));
  for (const key of Object.keys(periods) as (keyof typeof periods)[]) {
    const own = [player('a', { PTS: 10 }), player('b', { PTS: 30 }), player('c', { PTS: 15 })];
    const index = Object.keys(periods).indexOf(key);
    own[index % 3] = player(own[index % 3]!.id, { PTS: 40 + index });
    snapshot.periods[key].players = own;
    const result = playerZScores(snapshot.periods[key].players);
    assert.equal(result.players[0]!.id, own[index % 3]!.id);
    assert.equal(result.means.PTS, own.reduce((s, p) => s + p.stats.PTS!, 0) / 3);
    assert.deepEqual(result.players.map(p => p.rank), [1, 2, 3]);
  }
});
