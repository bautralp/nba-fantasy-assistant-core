import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLeague, createLeagueEvaluator } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { CATEGORIES } from '../../src/seasonAnalysis/model.ts';
import { applyScenario, emptyScenario, moveScenario, resetScenario, revalidate, simulateTrades, undoScenario, type TradeScenario } from '../../src/seasonAnalysis/trade.ts';
import { unsetGoals } from '../../src/seasonAnalysis/strategy.ts';
import type { LeagueTeam } from '../../src/features/season/model.ts';
import { league } from '../helpers/seasonLeagueFixture.ts';

const fixture = () => league([
  [[11, { AST: 8, REB: 3 }], [12, { AST: 2, REB: 4 }], [13, { AST: 1 }, 'bench'], [14, {}, 'ir']],
  [[21, { AST: 2, REB: 9 }], [22, { AST: 3, REB: 8 }], [23, { REB: 1 }, 'bench']],
  [[31, { AST: 5, REB: 5 }], [32, { AST: 5, REB: 5 }]],
  [[41, { AST: 4, REB: 6 }], [42, { AST: 1, REB: 7 }]],
]);
const step = (s: TradeScenario, teams: readonly LeagueTeam[], playerId: number, sourceTeamId: number, target: number | 'waiver') => {
  const r = moveScenario(s, teams, { playerId, sourceTeamId, target });
  if ('error' in r) throw new Error(r.error);
  return r.scenario;
};

test('scenario edits: one effective target per player, conflicts and no-ops rejected, undo/reset restore exact states', () => {
  const teams = fixture().league.teams;
  let s = step(emptyScenario(), teams, 11, 1, 2);
  s = step(s, teams, 21, 2, 1);
  assert.deepEqual(moveScenario(s, teams, { playerId: 11, sourceTeamId: 2, target: 3 }), { error: 'Oyuncunun başlangıç takımı doğrulanamadı.' });
  assert.deepEqual(moveScenario(s, teams, { playerId: 31, sourceTeamId: 3, target: 3 }), { error: 'Oyuncu zaten bu takımda.' });
  assert.deepEqual(moveScenario(s, teams, { playerId: 11, sourceTeamId: 1, target: 2 }), { error: 'Oyuncunun hedefi zaten bu.' });
  assert.deepEqual(moveScenario(s, teams, { playerId: 99, sourceTeamId: 1, target: 2 }), { error: 'Oyuncu başlangıç kadrolarında yok.' });
  assert.deepEqual(moveScenario(s, teams, { playerId: 31, sourceTeamId: 3, target: 77 }), { error: 'Hedef takım ligde yok.' });
  const retarget = step(s, teams, 11, 1, 3); // explicit replacement, not a copy
  assert.deepEqual(retarget.moves.filter(m => m.playerId === 11), [{ playerId: 11, sourceTeamId: 1, target: 3 }]);
  const home = step(retarget, teams, 11, 1, 1); // back to the starting owner removes the move
  assert.deepEqual(home.moves, [{ playerId: 21, sourceTeamId: 2, target: 1 }]);
  assert.deepEqual(undoScenario(home).moves, retarget.moves); assert.deepEqual(undoScenario(undoScenario(home)).moves, s.moves);
  const reset = resetScenario(home); assert.deepEqual(reset.moves, []); assert.deepEqual(undoScenario(reset).moves, home.moves);
  assert.equal(undoScenario(emptyScenario()).moves.length, 0);
});

test('atomic application keeps the ownership partition; waiver target removes the player from every team', () => {
  const input = fixture(), teams = input.league.teams, original = JSON.stringify(teams);
  let s = step(emptyScenario(), teams, 11, 1, 2); s = step(s, teams, 21, 2, 3); s = step(s, teams, 31, 3, 1); s = step(s, teams, 23, 2, 'waiver');
  const { teams: next, waiver } = applyScenario(teams, s);
  const owner = (id: number) => next.find(t => t.roster!.some(p => p.espnPlayerId === id))?.espnTeamId;
  assert.equal(owner(11), 2); assert.equal(owner(21), 3); assert.equal(owner(31), 1); assert.equal(owner(23), undefined);
  assert.deepEqual(waiver.map(p => p.espnPlayerId), [23]);
  const all = [...next.flatMap(t => t.roster!), ...waiver].map(p => p.espnPlayerId).sort((a, b) => a - b);
  assert.deepEqual(all, teams.flatMap(t => t.roster!).map(p => p.espnPlayerId).sort((a, b) => a - b));
  assert.equal(JSON.stringify(teams), original, 'ESPN snapshot rosters are not modified');
});

test('every team is re-ranked; a team with no move can change rank; values equal an independent analysis', () => {
  const input = fixture(), evaluator = createLeagueEvaluator(input), baseline = evaluator.evaluate(input.league.teams);
  // Three-team trade: 11 (AST 8) → team 2, 21 (REB 9) → team 3, 31 → team 1.
  let s = step(emptyScenario(), input.league.teams, 11, 1, 2); s = step(s, input.league.teams, 21, 2, 3); s = step(s, input.league.teams, 31, 3, 1);
  const r = simulateTrades({ evaluator, teams: input.league.teams, baseline, slots: input.league.rosterSlots, scenario: s, myTeamId: 1, goals: { ...unsetGoals(), AST: 'top1' } });
  assert.deepEqual(r.blockers, []); assert.deepEqual(r.involved, [1, 2, 3]);
  const oracle = analyzeLeague({ ...input, teams: applyScenario(input.league.teams, s).teams });
  for (const c of CATEGORIES) assert.deepEqual(r.after!.rankings[c].map(x => [x.teamId, x.rank, x.projectedValue]), oracle.rankings[c].map(x => [x.teamId, x.rank, x.projectedValue]));
  assert.equal(r.impacts.length, 4);
  const t4 = r.impacts.find(i => i.teamId === 4)!;
  assert.ok(t4.categories.every(c => c.delta === 0), 'team 4 roster unchanged');
  assert.ok(t4.categories.some(c => c.rankGain !== 0), 'team 4 relative rank still changes');
  // Weighted FG% after the move is team ΣFGM/ΣFGA, TO direction kept.
  const t1 = r.after!.teams.find(t => t.teamId === 1)!;
  assert.equal(r.after!.rankings['FG%'].find(x => x.teamId === 1)!.projectedValue, 100 * t1.partialTotals.FGM / t1.partialTotals.FGA);
  const to = r.after!.rankings.TO; assert.ok(to[0].projectedValue! <= to.at(-1)!.projectedValue!);
});

test('capacity, IR, stale snapshot and empty scenarios are blocked or disclosed, never evaluated silently', () => {
  const input = fixture(), evaluator = createLeagueEvaluator(input), baseline = evaluator.evaluate(input.league.teams), teams = input.league.teams;
  const run = (scenario: TradeScenario, t: readonly LeagueTeam[] = teams) => simulateTrades({ evaluator, teams: t, baseline, slots: input.league.rosterSlots, scenario, myTeamId: 1, goals: unsetGoals() });
  assert.match(run(emptyScenario()).blockers.join(), /hamle yok/);
  // Team 3 (2 players) receives 3 more → 5 regular > capacity 4.
  let crowd = step(emptyScenario(), teams, 11, 1, 3); crowd = step(crowd, teams, 12, 1, 3); crowd = step(crowd, teams, 21, 2, 3);
  assert.match(run(crowd).blockers.join(), /T3: kadro 5\/4 ile kapasiteyi aşıyor/);
  const balanced = step(crowd, teams, 31, 3, 'waiver');
  assert.deepEqual(run(balanced).blockers, [], 'sending a player to waiver resolves capacity');
  const ir = run(step(emptyScenario(), teams, 14, 1, 4));
  assert.deepEqual(ir.blockers, []); assert.match(ir.notes.join(), /IR'de; yeni takımda da IR/);
  assert.equal(applyScenario(teams, step(emptyScenario(), teams, 14, 1, 4)).teams.find(t => t.espnTeamId === 4)!.roster!.find(p => p.espnPlayerId === 14)!.placement, 'ir');
  // Refreshed snapshot where player 11 already moved on ESPN: the move is invalid.
  const refreshed = teams.map(t => t.espnTeamId === 1 ? { ...t, roster: t.roster!.filter(p => p.espnPlayerId !== 11) } : t.espnTeamId === 4 ? { ...t, roster: [...t.roster!, teams[0].roster![0]] } : t);
  const s = step(emptyScenario(), teams, 11, 1, 2);
  assert.deepEqual(revalidate(s, refreshed).removed, s.moves); assert.equal(revalidate(s, teams).removed.length, 0);
  assert.match(run(s, refreshed).blockers.join(), /güncel kadrolarla uyuşmuyor/);
});
