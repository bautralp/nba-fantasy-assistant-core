import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from '../helpers/draftFixture.ts';
import { analysisFixture } from '../helpers/analysisFixture.ts';
import { selectDraftAnalysis } from '../../src/application/analysisSelectors.ts';
import { selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { NINE_CATEGORIES, createUnsetTargets } from '../../src/domain/models/categories.ts';
import { categoryValues, rankTeams, matchLineup, opponentAnalysis, categoryBalance } from '../../src/engine/index.ts';
import { restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { validateWorkspace } from '../../src/domain/rules/invariants.ts';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import type { TeamScore } from '../../src/engine/teamScores.ts';
const select = (w: WorkspaceSnapshot) => selectDraftAnalysis(w, selectDraftWorkspace(w));
const pick = (w: WorkspaceSnapshot, n: number, teamId = 't0') => applyDraftCommand(w, { kind: 'assign', playerId: `p${n}`, teamId, confirmed: true });
function compare(a: unknown, b: unknown): void {
  if (typeof b === 'number') { assert.equal(typeof a, 'number'); assert.ok(Math.abs((a as number) - b) <= 1e-9 * Math.max(1, Math.abs(b))); }
  else if (b && typeof b === 'object') { assert.deepEqual(Object.keys(a as object), Object.keys(b)); for (const k of Object.keys(b)) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]); }
  else assert.deepEqual(a, b);
}
for (const name of ['empty-rosters', 'early', 'middle', 'late', 'completed', 'all-unset', 'all-punt', 'invalid-projections', 'multi-position-roster', 'identical-statistics']) test(`analysis presentation matches fixed v3.3 scores/ranks/balance/opponents/lineups: ${name}`, () => {
  const { workspace: w, expected: e } = analysisFixture(name);
  assert.deepEqual(validateWorkspace(w), []);
  const before = JSON.stringify(w), v = selectDraftWorkspace(w), a = selectDraftAnalysis(w, v);
  compare(v.scores.map(({ teamId, ...s }) => ({ ...s, i: Number(teamId.slice(1)) })), e.scores.map((s: TeamScore & { i: number }) => ({ name: s.name, count: s.count, rated: s.rated, sum: s.sum, score: s.score, i: s.i })));
  for (const c of a.categories) {
    for (const s of v.scores) assert.equal(v.ranks[c.cat][s.teamId], e.ranks[c.cat][s.teamId.slice(1)]);
    const expectedLeaders = e.scores.filter((s: TeamScore) => s.score[c.cat] !== null).sort((x: TeamScore & { i: number }, y: TeamScore & { i: number }) => y.score[c.cat]! - x.score[c.cat]! || x.i - y.i).slice(0, 5);
    assert.deepEqual(c.leaders.map(t => t.teamId), expectedLeaders.map((t: { i: number }) => `t${t.i}`));
    c.leaders.forEach(t => { assert.equal(t.rank, e.ranks[c.cat][t.teamId.slice(1)]); compare(t.score, e.scores[Number(t.teamId.slice(1))].score[c.cat]); });
    compare(c.balance, e.balance.byCat[c.cat]);
  }
  compare(v.plan, e.balance);
  compare(v.opponents.map(({ teamId, ...o }) => ({ ...o, teamIndex: Number(teamId.slice(1)) })), e.threats.map(({ teamIndex, ...o }: { teamIndex: number }) => ({ ...o, teamIndex })));
  a.rosters.forEach((t, i) => assert.deepEqual(t.lineup, e.lineups[i]));
  assert.equal(JSON.stringify(w), before);
});
test('empty/null teams are omitted, first pick scores all nine categories without fake zero teams', () => {
  assert.ok(select(fresh()).categories.every(c => c.leaders.length === 0 && c.score === null));
  const a = select(pick(fresh(), 0)); assert.deepEqual(a.categories.map(c => c.cat), NINE_CATEGORIES);
  assert.ok(a.categories.every(c => c.leaders.length === 1 && c.leaders[0].teamId === 't0' && c.leaders[0].rank === 1 && c.leaders[0].isMine));
});
test('intentional legacy view difference: engine tie ranks 1,2,2,4 and deterministic top-five team count', () => {
  const w = fresh(), v = selectDraftWorkspace(w);
  const values = [4, 3, 3, 2, 1, 1, null];
  const scores = values.map((score, i) => ({ teamId: `t${i}`, name: `Team ${i}`, count: 1, rated: 1, sum: categoryValues(() => 0), score: categoryValues(() => score) }));
  const ranks = rankTeams(scores);
  const a = selectDraftAnalysis(w, { ...v, scores: [...scores].reverse(), ranks });
  for (const c of a.categories) {
    assert.deepEqual(c.leaders.map(t => t.rank), [1, 2, 2, 4, 5]);
    assert.deepEqual(c.leaders.map(t => t.teamId), ['t0', 't1', 't2', 't3', 't4']);
    assert.equal(c.leaders.length, 5);
  }
  const chained = [1, 1 - 0.6e-10, 1 - 1.2e-10, 0].map((n, i) => ({ ...scores[i], score: categoryValues(() => n) }));
  const r = rankTeams(chained);
  assert.deepEqual(selectDraftAnalysis(w, { ...v, scores: chained, ranks: r }).categories[0].leaders.map(t => t.rank), [1, 1, 1, 4]);
});
test('assign/transfer/remove/undo recalculate leaders using team IDs even when teams are reordered', () => {
  let w = fresh(4); w = { ...w, teams: [...w.teams].reverse() };
  w = pick(w, 0, 't8'); assert.equal(select(w).categories[0].leaders[0].teamId, 't8');
  w = applyDraftCommand(w, { kind: 'transfer', playerId: 'p0', teamId: 't0' });
  assert.equal(select(w).categories[0].leaders[0].isMine, true);
  w = pick(w, 1, 't2'); w = applyDraftCommand(w, { kind: 'remove', playerId: 'p0' });
  assert.deepEqual(select(w).categories[0].leaders.map(t => t.teamId), ['t2']);
  w = applyDraftCommand(w, { kind: 'undo', playerId: 'p1' }); assert.equal(select(w).categories[0].leaders.length, 0);
});
test('missing/excluded roster members survive active dataset switch with separate rated count and warnings', () => {
  let w = pick(pick(fresh(4), 0), 1);
  w = { ...w, datasets: [...w.datasets, { ...w.datasets[0], id: 'new' }], league: { ...w.league, activeDatasetId: 'new' }, projections: [...w.projections, { playerId: 'p0', datasetId: 'new', status: 'excluded', reasons: ['invalid active'] }] };
  const a = select(w), mine = a.rosters.find(t => t.id === 't0')!;
  assert.equal(mine.count, 2); assert.equal(mine.rated, 0); assert.ok(a.categories.every(c => c.score === null && !c.leaders.length));
  const members = [...mine.slots.flatMap(s => s.player ? [s.player] : []), ...mine.unplaced];
  assert.equal(members.length, 2); assert.ok(members.every(p => p.warning)); assert.ok(members.some(p => p.warning.includes('invalid active')));
});
test('rosters preserve engine placement, slot order, multi-position reassignment, G/F and unknown constraints', () => {
  let w = fresh(13); for (let i = 0; i < 13; i++) w = pick(w, i);
  w = { ...w, eligibility: w.eligibility.map((e, i) => ({ ...e, positions: i === 0 ? ['PG', 'SG'] : i === 1 ? ['PG'] : i === 2 ? ['F'] : i === 3 ? [] : ['G'] })) };
  const v = selectDraftWorkspace(w), a = selectDraftAnalysis(w, v), mine = a.rosters.find(t => t.id === 't0')!;
  assert.equal(a.rosters.length, 10); assert.equal(mine.draftPosition, 1);
  assert.deepEqual(mine.slots.map(s => s.slot), ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'UTIL', 'UTIL', 'BENCH', 'BENCH', 'BENCH']);
  assert.deepEqual(mine.lineup, matchLineup(v.roster.map(p => ({ playerId: p.playerId, positions: v.positions.get(p.playerId)! }))));
  assert.equal(mine.slots[0].player!.playerId, 'p1'); assert.equal(mine.slots[1].player!.playerId, 'p0');
  assert.equal(mine.slots[2].player, undefined); assert.equal(mine.slots[3].player, undefined); assert.equal(mine.slots[6].player!.playerId, 'p2');
  assert.ok(mine.slots.slice(7).some(s => s.player?.playerId === 'p3')); assert.equal(mine.unplaced.length, 3);
  assert.equal(mine.slots.filter(s => s.player).length + mine.unplaced.length, 13);
});
test('league eligibility override including empty array is honored for every roster', () => {
  let w = pick(fresh(1), 0, 't5');
  w = { ...w, eligibility: [...w.eligibility, { playerId: 'p0', season: 'fixture', scope: { kind: 'league', leagueId: 'league' }, positions: [] }] };
  const t = select(w).rosters.find(t => t.id === 't5')!;
  assert.equal(t.slots[4].player, undefined); assert.deepEqual(t.slots[7].player?.positions, []);
});
test('strategy target is independent of current rank and presentation keeps exact engine balance fields', () => {
  const w = pick(fresh(6), 0), before = selectDraftWorkspace(w);
  const next = applyDraftCommand(w, { kind: 'strategy', targets: { ...createUnsetTargets(), PTS: 'top7', AST: 'punt' } });
  const v = selectDraftWorkspace(next), a = selectDraftAnalysis(next, v);
  assert.deepEqual(v.scores, before.scores); assert.deepEqual(v.ranks, before.ranks); assert.deepEqual(next.draftSession, w.draftSession);
  const pts = a.categories.find(c => c.cat === 'PTS')!; assert.equal(pts.target, 'top7'); assert.equal(pts.rank, 1);
  assert.deepEqual(pts.balance, categoryBalance(v.scores, 't0', v.targets, v.ranks).byCat.PTS);
  assert.equal(a.categories.find(c => c.cat === 'AST')!.balance, undefined);
  assert.equal(a.categories.find(c => c.cat === 'REB')!.balance, undefined);
  assert.notDeepEqual(v.topFive, before.topFive);
  assert.deepEqual(next.strategies.filter(s => s.teamId !== 't0'), w.strategies.filter(s => s.teamId !== 't0'));
});
test('opponent presentation preserves sign, order, strict 0.65 boundary and low/medium confidence from engine', () => {
  const w = fresh(), v = selectDraftWorkspace(w), targets = { ...createUnsetTargets(), PTS: 'top1' as const };
  const scores = [0, -.65, -.649999, 2, 0].map((n, i) => ({ teamId: `t${i}`, name: `Team ${i}`, count: 3, rated: i === 4 ? 0 : 3, sum: categoryValues(() => n), score: categoryValues(() => n) }));
  let opponents = opponentAnalysis(scores, 't0', targets);
  assert.deepEqual(opponents.map(o => o.teamId), ['t3', 't2']); assert.equal(opponents[0].gap, 2); assert.equal(opponents[0].ahead, true); assert.equal(opponents[1].ahead, false);
  assert.ok(opponents.every(o => o.confidence === 'Orta'));
  scores[0].rated = 2; opponents = opponentAnalysis(scores, 't0', targets); assert.ok(opponents.every(o => o.confidence === 'Düşük'));
  const a = selectDraftAnalysis(w, { ...v, scores, targets, opponents, roster: [{ playerId: 'p0', teamId: 't0' }] }); assert.equal(a.opponentEmpty, '');
});
test('all six opponent empty states are distinct, never imply a category win', () => {
  const empty = select(fresh()).opponentEmpty;
  const noMine = select(pick(fresh(), 0, 't1')).opponentEmpty;
  const w = pick(fresh(), 0), unset = select(w).opponentEmpty;
  const puntW = applyDraftCommand(w, { kind: 'strategy', targets: { ...createUnsetTargets(), PTS: 'punt' } });
  const punt = select(puntW).opponentEmpty;
  const active = applyDraftCommand(w, { kind: 'strategy', targets: { ...createUnsetTargets(), PTS: 'top1' } });
  const insufficient = select(active).opponentEmpty;
  const v = selectDraftWorkspace(pick(active, 1, 't1'));
  const none = selectDraftAnalysis(active, { ...v, opponents: [] }).opponentEmpty;
  assert.equal(new Set([empty, noMine, unset, punt, insufficient, none]).size, 6);
  assert.match(none, /kazanacağınız anlamına gelmez/);
});
test('analysis is derived after backup/restore, deterministic, and never written into workspace', () => {
  const { workspace: w } = analysisFixture('middle'); const json = JSON.stringify(w);
  const a = select(w), restored = restoreWorkspaceJson(json); assert.ok(restored.ok);
  assert.deepEqual(select(restored.value), a); assert.deepEqual(select(w), a); assert.equal(JSON.stringify(w), json);
  assert.ok(!json.includes('leaders')); assert.ok(!json.includes('paceGap'));
});
