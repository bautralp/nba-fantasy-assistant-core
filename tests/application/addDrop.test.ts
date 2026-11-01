import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLeague, createLeagueEvaluator } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { CATEGORIES } from '../../src/seasonAnalysis/model.ts';
import { bestDrop, simulateAddDrop } from '../../src/seasonAnalysis/addDrop.ts';
import { rebuildTeam } from '../../src/seasonAnalysis/rosterMoves.ts';
import { unsetGoals } from '../../src/seasonAnalysis/strategy.ts';
import type { WaiverPlayer } from '../../src/infrastructure/espn/waiverPool.ts';
import { league, player } from '../helpers/seasonLeagueFixture.ts';

const fa = (id: number, extra: Partial<WaiverPlayer> = {}): WaiverPlayer => ({ espnPlayerId: id, name: `FA${id}`, proTeamId: 1, eligibleSlotIds: [11, 12, 13], primaryPosition: null, displayPositions: [], status: 'FREEAGENT', waiverProcessDate: null, injuryStatus: null, percentOwned: 1, ...extra });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
// Team 1 is mid-table in 3PM; FA 90 is a pure shooter with poor FT, FA 91 a rebounder.
const fixture = () => league([
  [[11, { '3PM': 2, REB: 5 }], [12, { '3PM': 1, REB: 9 }], [13, { '3PM': 1, REB: 2 }, 'bench'], [14, {}, 'ir']],
  [[21, { '3PM': 3, REB: 6 }], [22, { '3PM': 2, REB: 6 }]],
  [[31, { '3PM': 1, REB: 8 }], [32, { '3PM': 1, REB: 8 }]],
], [[90, { '3PM': 5, REB: 3, FTM: 1, FTA: 5 }], [91, { '3PM': 0, REB: 14 }], [92, {}]]);
function setup() {
  const input = fixture(), evaluator = createLeagueEvaluator(input), baseline = evaluator.evaluate(input.league.teams);
  const projection = (id: number) => input.projections.find(p => p.espnId === id);
  const args = (add: WaiverPlayer) => ({ evaluator, teams: input.league.teams, baseline, slots: input.league.rosterSlots, myTeamId: 1, add, goals: unsetGoals(), projection: projection(add.espnPlayerId) });
  return { input, evaluator, baseline, args };
}

test('add/drop before/after equals an independent full analysis of the edited roster; every team is re-ranked', () => {
  const { input, args } = setup(), original = JSON.stringify(input);
  const r = simulateAddDrop({ ...args(fa(90)), dropId: 12 });
  assert.deepEqual(r.blockers, []);
  const manual = input.league.teams.map(t => t.espnTeamId === 1 ? { ...t, roster: [...t.roster!.filter(p => p.espnPlayerId !== 12), { ...player(90), name: 'FA90', lineupSlotId: 11, placement: 'active' as const }] } : t);
  const oracle = analyzeLeague({ ...input, teams: manual });
  for (const c of CATEGORIES) {
    assert.deepEqual(r.after!.rankings[c].map(x => [x.teamId, x.rank, x.projectedValue]), oracle.rankings[c].map(x => [x.teamId, x.rank, x.projectedValue]));
    const i = r.impact!.categories.find(x => x.category === c)!;
    close(i.delta, i.after - i.before); assert.equal(i.rankGain, i.beforeRank - i.afterRank);
  }
  // Weighted FT%: team ΣFTM/ΣFTA after the move, never an average of player percentages.
  const t1 = r.after!.teams.find(t => t.teamId === 1)!;
  close(r.impact!.categories.find(c => c.category === 'FT%')!.after, 100 * t1.partialTotals.FTM / t1.partialTotals.FTA);
  // 3PM: 11 (2) + 90 (5) active → 14 over two games; was 2+1 → 6. Rank 2 → 1.
  const three = r.impact!.categories.find(c => c.category === '3PM')!;
  close(three.before, 6); close(three.after, 14); assert.equal(three.beforeRank, 2); assert.equal(three.afterRank, 1);
  // Team 2 had 3PM rank 1; it moves down without any roster change of its own.
  assert.equal(r.before.rankings['3PM'].find(x => x.teamId === 2)!.rank, 1); assert.equal(r.after!.rankings['3PM'].find(x => x.teamId === 2)!.rank, 2);
  assert.equal(JSON.stringify(input), original, 'source league is never mutated');
});

test('invalid simulations are blocked before calculation: owned player, same player, foreign drop, missing projection, capacity', () => {
  const { args } = setup();
  assert.match(simulateAddDrop({ ...args(fa(21)), dropId: 12 }).blockers.join(), /kadrosunda; havuzda değil/);
  assert.match(simulateAddDrop({ ...args(fa(12)), dropId: 12 }).blockers.join(), /Aynı oyuncu/);
  assert.match(simulateAddDrop({ ...args(fa(90)), dropId: 21 }).blockers.join(), /kadronda değil/);
  const none = simulateAddDrop({ ...args(fa(93)), dropId: 12 });
  assert.match(none.blockers.join(), /tahmini yok/); assert.equal(none.after, null);
  assert.match(simulateAddDrop({ ...args(fa(90, { proTeamId: 7 })), dropId: 12 }).blockers.join(), /NBA takımı/);
  assert.match(simulateAddDrop({ ...args(fa(90, { eligibleSlotIds: [12, 13] })), dropId: 12 }).blockers.join(), /aktif slot/);
  // Dropping the IR player does not free a regular slot: 4 regular players > capacity 4? (2 UTIL + 2 bench = 4).
  const ir = simulateAddDrop({ ...args(fa(90)), dropId: 14 });
  assert.deepEqual(ir.blockers, [], 'room on the bench'); assert.match(ir.notes.join(), /IR'de; bırakmak normal kadro yeri açmaz/);
  const full = setup();
  const crowded = full.input.league.teams.map(t => t.espnTeamId === 1 ? { ...t, roster: [...t.roster!, { ...player(15, 'bench') }] } : t);
  const blocked = simulateAddDrop({ ...full.args(fa(90)), teams: crowded, dropId: 14 });
  assert.match(blocked.blockers.join(), /kapasiteyi aşıyor/);
});

test('incoming player takes the vacated active slot only when eligible; otherwise bench. IR stays IR', () => {
  const team = { espnTeamId: 1, name: 'T1', rank: null, record: null, gamesBack: null, roster: [{ ...player(1), lineupSlotId: 4, eligibleSlotIds: [4, 11] }, player(2), player(3, 'ir')] };
  const center = rebuildTeam(team, new Set([1]), [{ ...player(9, 'bench'), eligibleSlotIds: [4, 11, 12] }]);
  assert.deepEqual(center.roster!.find(p => p.espnPlayerId === 9)!, { ...player(9, 'bench'), eligibleSlotIds: [4, 11, 12], lineupSlotId: 4, placement: 'active' });
  const guard = rebuildTeam(team, new Set([1]), [{ ...player(9, 'bench'), eligibleSlotIds: [0, 11, 12] }]);
  assert.equal(guard.roster!.find(p => p.espnPlayerId === 9)!.placement, 'bench');
  const injured = rebuildTeam(team, new Set([2]), [player(8, 'ir')]);
  assert.equal(injured.roster!.find(p => p.espnPlayerId === 8)!.lineupSlotId, 13);
  assert.equal(team.roster.length, 3, 'source roster untouched');
});

test('best drop maximises the strategy score; waiver status and injury are disclosed, never assumed valid', () => {
  const { args } = setup();
  const best = bestDrop(args(fa(90, { status: 'WAIVERS', waiverProcessDate: '2026-10-28T07:00:00.000Z', injuryStatus: 'DAY_TO_DAY' })), [11, 12, 13])!;
  for (const id of [11, 12, 13]) assert.ok(simulateAddDrop({ ...args(fa(90)), dropId: id }).impact!.strategyScore <= best.impact!.strategyScore + 1e-12);
  assert.match(best.notes.join(' '), /waiver'da: ESPN talebi 28\.10\.2026 tarihinde işler; hak sırası ve sonucu bilinmiyor/);
  assert.match(best.notes.join(' '), /DAY_TO_DAY/);
});
