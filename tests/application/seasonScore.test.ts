import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchupScorePresentation } from '../../src/features/season/matchupScorePresentation.ts';
import type { MatchupSide } from '../../src/features/season/model.ts';
const side: MatchupSide = { teamId: 1, score: 0, categoryRecord: { wins: 5, losses: 2, ties: 2 }, categoryStats: null };
for (const format of ['H2H_MOST_CATEGORIES', 'H2H_EACH_CATEGORY']) {
  test(`${format}: provider category record takes precedence over any totalPoints`, () => {
    for (const score of [0, 123.5, null]) assert.deepEqual(matchupScorePresentation(format, { ...side, score }), { label: 'Kategori W/L/T', value: '5 / 2 / 2' });
  });
  test(`${format}: missing records stay unavailable; provider zeros and partial records stay distinct`, () => {
    for (const categoryRecord of [null, { wins: null, losses: null, ties: null }]) assert.equal(matchupScorePresentation(format, { ...side, categoryRecord }).value, 'Mevcut değil');
    assert.equal(matchupScorePresentation(format, { ...side, categoryRecord: { wins: 0, losses: 0, ties: 0 } }).value, '0 / 0 / 0');
    assert.equal(matchupScorePresentation(format, { ...side, categoryRecord: { wins: 0, losses: null, ties: 2 } }).value, '0 / Mevcut değil / 2');
    assert.equal(side.categoryStats, null);
  });
}
test('only the explicit H2H_POINTS format exposes provider points, preserving zero and unavailable', () => {
  for (const score of [0, 123.5, null]) assert.deepEqual(matchupScorePresentation('H2H_POINTS', { ...side, score }), { label: 'Haftalık puan', value: score === null ? 'Mevcut değil' : String(score) });
  for (const format of ['ROTO', 'UNKNOWN', 'TOTAL_POINTS', 'CUSTOM_POINTS', 'H2H_CATEGORY']) assert.deepEqual(matchupScorePresentation(format, { ...side, score: 123.5 }), { label: 'Haftalık skor', value: 'Mevcut değil' });
});
test('unplayed or absent sides keep the scoring format label without synthetic scores', () => {
 assert.deepEqual(matchupScorePresentation('H2H_MOST_CATEGORIES', null), { label: 'Kategori W/L/T', value: 'Mevcut değil' });
 assert.deepEqual(matchupScorePresentation('H2H_POINTS', null), { label: 'Haftalık puan', value: 'Mevcut değil' });
 assert.deepEqual(matchupScorePresentation('ROTO', null), { label: 'Haftalık skor', value: 'Mevcut değil' });
});
