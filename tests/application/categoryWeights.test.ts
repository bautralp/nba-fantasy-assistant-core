import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NINE_CATEGORIES } from '../../src/domain/models/categories.ts';
import { parseSnapshot, periods, type Period } from '../../src/features/rankings/centralStats.ts';
import { parseProjections } from '../../src/features/rankings/rosProjection.ts';
import { playerZScores } from '../../src/features/rankings/playerZScores.ts';
import { applyWeights, DEFAULT_WEIGHTS, WEIGHTS_SESSION_KEY, loadWeights, parseWeights, rosZScores, saveWeights, type CategoryWeights } from '../../src/features/rankings/categoryWeights.ts';

const actual = parseSnapshot(JSON.parse(readFileSync(new URL('../../public/data/player-stats.json', import.meta.url), 'utf8')));
const ros = parseProjections(JSON.parse(readFileSync(new URL('../../public/data/player-projections.json', import.meta.url), 'utf8')));
const weights = (patch: Partial<Record<string, number>>) => ({ ...DEFAULT_WEIGHTS, ...patch }) as CategoryWeights;
const summary = (rows: readonly { id: string; rank: number; totalZ: number }[]) => rows.map(({ id, rank, totalZ }) => ({ id, rank, totalZ }));

test('all weights at 1 reproduce today’s Actual ranking exactly in every period', () => {
  for (const period of Object.keys(periods) as Period[]) {
    const ranked = playerZScores(actual.periods[period].players).players;
    assert.ok(ranked.length > 0, period);
    assert.deepEqual(summary(applyWeights(ranked, DEFAULT_WEIGHTS)), summary(ranked), period);
  }
});

test('all weights at 1 reproduce the published ROS rank and TOTAL Z exactly', () => {
  const recomputed = applyWeights(rosZScores(ros), DEFAULT_WEIGHTS);
  const published = ros.players.filter(p => p.status === 'available');
  assert.equal(recomputed.length, published.length);
  assert.ok(published.length > 100);
  const byId = new Map(recomputed.map(p => [p.id, p]));
  for (const p of published) {
    assert.equal(byId.get(p.id)?.rank, p.rank, p.id);
    assert.equal(byId.get(p.id)?.totalZ, p.totalZ, p.id);
  }
});

test('weights scale category z-scores without changing them; 0 punts a category', () => {
  const ranked = playerZScores(actual.periods.season.players).players;
  const punt = weights({ 'FT%': 0, TO: 0, PTS: 2, BLK: 0.25 });
  const result = applyWeights(ranked, punt);
  const original = new Map(ranked.map(p => [p.id, p]));
  for (const p of result) {
    const before = original.get(p.id)!;
    assert.deepEqual(p.z, before.z, 'z-scores are untouched');
    const expected = NINE_CATEGORIES.reduce((sum, c) => sum + before.z[c] * punt[c], 0);
    assert.equal(p.totalZ, expected);
  }
  for (let i = 1; i < result.length; i++) assert.ok(result[i - 1].totalZ >= result[i].totalZ);
  assert.deepEqual(result.map(p => p.rank), result.map((_, i) => i + 1));
  assert.notDeepEqual(result.map(p => p.id), ranked.map(p => p.id), 'a different weighting changes the order');
  // Inputs are not mutated.
  assert.deepEqual(summary(ranked), summary(playerZScores(actual.periods.season.players).players));
});

test('ties keep the existing id order and every-zero weights yield a stable id order', () => {
  const zero = weights(Object.fromEntries(NINE_CATEGORIES.map(c => [c, 0])));
  const result = applyWeights(playerZScores(actual.periods.season.players).players, zero);
  assert.ok(result.every(p => p.totalZ === 0));
  const ids = result.map(p => p.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
});

test('weights parse strictly and persist only in session storage', () => {
  assert.equal(parseWeights(null), DEFAULT_WEIGHTS);
  assert.equal(parseWeights({ ...DEFAULT_WEIGHTS, PTS: 4 }), DEFAULT_WEIGHTS, 'unsupported option');
  assert.equal(parseWeights({ PTS: 2 }), DEFAULT_WEIGHTS, 'partial record');
  assert.deepEqual(parseWeights(weights({ PTS: 1.5 })), weights({ PTS: 1.5 }));
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  assert.equal(saveWeights(weights({ TO: 0 }), storage), true);
  assert.deepEqual(loadWeights(storage), weights({ TO: 0 }));
  assert.equal(saveWeights(DEFAULT_WEIGHTS, storage), true);
  assert.equal(store.has(WEIGHTS_SESSION_KEY), false, 'defaults clear the stored value');
  store.set(WEIGHTS_SESSION_KEY, '{broken');
  assert.equal(loadWeights(storage), DEFAULT_WEIGHTS);
  const failing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(loadWeights(failing), DEFAULT_WEIGHTS);
  assert.equal(saveWeights(weights({ TO: 0 }), failing), false);
});
