import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLeague, createLeagueEvaluator } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { CATEGORIES } from '../../src/seasonAnalysis/model.ts';
import { categoryStandings, compareTeam, rosterContributions, STRATEGY_WEIGHTS } from '../../src/seasonAnalysis/teamInsights.ts';
import { parseSeasonGoals, readSeasonGoals, seasonStrategyKey, unsetGoals, writeSeasonGoals, type SeasonCategoryGoals } from '../../src/seasonAnalysis/strategy.ts';
import { standingText, impactSentences } from '../../src/features/season/strategyPresentation.ts';
import type { LeagueTeam } from '../../src/features/season/model.ts';
import { league } from '../helpers/seasonLeagueFixture.ts';
import type { Category } from '../../src/domain/models/categories.ts';

const goals = (g: Partial<Record<Category, SeasonCategoryGoals[Category]>>): SeasonCategoryGoals => ({ ...unsetGoals(), ...g });
const close = (a: number | null | undefined, b: number, eps = 1e-9) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) <= eps, `${a} != ${b}`);
// Four teams; per-game AST 3/4/7/9 per player → team totals 12/16/28/36 (2 players × 2 games).
const four = () => league([
  [[11, { AST: 3, TO: 1 }], [12, { AST: 3, TO: 1 }]],
  [[21, { AST: 4, TO: 3 }], [22, { AST: 4, TO: 3 }]],
  [[31, { AST: 7, TO: 2 }], [32, { AST: 7, TO: 2 }]],
  [[41, { AST: 9, TO: 4 }], [42, { AST: 9, TO: 4 }]],
]);

test('stored goals: strict schema, independent key per league/season/team, failures become unset with a visible message', () => {
  const g = goals({ AST: 'top3', BLK: 'punt' }), store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const key = seasonStrategyKey(1, 2027, 4);
  assert.notEqual(key, seasonStrategyKey(1, 2027, 5)); assert.notEqual(key, seasonStrategyKey(1, 2026, 4));
  assert.equal(writeSeasonGoals(storage, key, g), null);
  assert.deepEqual(readSeasonGoals(storage, key), { goals: g, error: null });
  assert.deepEqual(readSeasonGoals(storage, seasonStrategyKey(1, 2027, 5)), { goals: unsetGoals(), error: null });
  for (const bad of ['{', JSON.stringify({ schemaVersion: 2, goals: g }), JSON.stringify({ schemaVersion: 1, goals: { ...g, AST: 'top2' } }), JSON.stringify({ schemaVersion: 1, goals: { AST: 'top3' } })]) {
    store.set(key, bad); const r = readSeasonGoals(storage, key);
    assert.deepEqual(r.goals, unsetGoals()); assert.match(r.error!, /okunamadı/);
  }
  assert.equal(parseSeasonGoals({ schemaVersion: 1, goals: { ...g, extra: 'top1' } }), null);
  assert.match(writeSeasonGoals({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, key, g)!, /kaydedilemedi/);
});

test('goal gaps: exact distance to the k-th best other team, ties share the rank, TO counts fewer turnovers', () => {
  const analysis = analyzeLeague(four()); assert.equal(analysis.status, 'ready');
  const s = categoryStandings(analysis, 1, goals({ AST: 'top3', TO: 'top1', PTS: 'top1', BLK: 'punt' }))!;
  const ast = s.find(x => x.category === 'AST')!;
  assert.equal(ast.rank, 4); assert.equal(ast.status, 'missed'); close(ast.gap, 16 - 12);
  assert.equal(standingText(ast), 'İlk 3 hedefin için yaklaşık 4 asist daha gerekiyor.');
  const to = s.find(x => x.category === 'TO')!; // T1 has the fewest TO (4).
  assert.equal(to.rank, 1); assert.equal(to.status, 'met'); close(to.cushion, 8 - 4);
  // PTS: every team equal → everyone rank 1, goal met with zero cushion, zero variance.
  const pts = s.find(x => x.category === 'PTS')!;
  assert.equal(pts.rank, 1); assert.equal(pts.status, 'met'); assert.equal(pts.cushion, 0); assert.equal(pts.sd, 0);
  assert.equal(pts.weightReason, 'edge');
  assert.equal(s.find(x => x.category === 'BLK')!.weight, 0);
  const t2 = categoryStandings(analysis, 2, goals({ AST: 'top3', TO: 'top3' }))!;
  assert.equal(t2.find(x => x.category === 'AST')!.status, 'met'); close(t2.find(x => x.category === 'AST')!.cushion, 16 - 12);
  const t2to = t2.find(x => x.category === 'TO')!; // T2 TO 12 is worst-but-one (T4 16).
  assert.equal(t2to.rank, 3); assert.equal(t2to.status, 'met'); close(t2to.cushion, 16 - 12);
  const t4 = categoryStandings(analysis, 4, goals({ TO: 'top1' }))!.find(x => x.category === 'TO')!;
  assert.equal(t4.status, 'missed'); close(t4.gap, 16 - 4);
  assert.equal(standingText(t4), 'İlk 1 hedefin için yaklaşık 12 daha az top kaybı gerekiyor.');
  // Goal larger than the league: met without a cushion claim.
  const small = categoryStandings(analysis, 4, goals({ AST: 'top7' }))!.find(x => x.category === 'AST')!;
  assert.equal(small.status, 'met'); assert.equal(small.cushion, null);
});

test('FG%/FT% gaps are percentage points of weighted team totals; makes needed close the gap at the same attempts', () => {
  const input = league([
    [[11, { FGM: 4, FGA: 10 }], [12, { FGM: 1, FGA: 2 }]],
    [[21, { FGM: 5, FGA: 10 }], [22, { FGM: 5, FGA: 10 }]],
    [[31, { FGM: 2, FGA: 10 }], [32, { FGM: 9, FGA: 10 }]],
  ]);
  const a = analyzeLeague(input), t1 = a.teams.find(t => t.teamId === 1)!;
  // Weighted: (4+1)/(10+2) = 41.67%, never mean(40%, 50%) = 45%.
  close(a.rankings['FG%'].find(r => r.teamId === 1)!.projectedValue, 100 * 5 / 12);
  const fg = categoryStandings(a, 1, goals({ 'FG%': 'top1' }))!.find(x => x.category === 'FG%')!;
  close(fg.gap, 55 - 100 * 5 / 12); close(fg.attempts, t1.partialTotals.FGA);
  close(100 * (t1.partialTotals.FGM + fg.makesNeeded!) / t1.partialTotals.FGA, 55);
  assert.match(standingText(fg), /yüzde puanı daha \(aynı deneme hacminde yaklaşık 4 isabet\) gerekiyor/);
});

test('punt keeps the real values and ranks but contributes 0 to strategy score; weights follow the documented table', () => {
  const input = four(), ev = createLeagueEvaluator(input);
  const g = goals({ AST: 'punt', TO: 'top1' }), r = rosterContributions(ev, input.league.teams, 1, g, input.projections)!;
  const astBefore = r.standings.find(x => x.category === 'AST')!;
  assert.equal(astBefore.value, 12); assert.equal(astBefore.rank, 4);
  for (const p of r.players) {
    const ast = p.impact!.categories.find(c => c.category === 'AST')!;
    assert.ok(ast.delta !== 0, 'punt category change is still computed');
    close(p.impact!.strategyScore, p.impact!.categories.reduce((s, c) => s + c.weight * c.deltaZ, 0));
    assert.equal(ast.weight, 0);
    assert.doesNotMatch(impactSentences(p.impact!).join(' '), /AST/);
  }
  assert.deepEqual(STRATEGY_WEIGHTS, { punt: 0, unset: 1, close: 2, far: 1.5, edge: 1, safe: 0.5 });
  const none = rosterContributions(ev, input.league.teams, 1, unsetGoals(), input.projections)!;
  assert.ok(none.standings.every(x => x.weight === 1));
  assert.deepEqual(none.standings.map(x => x.value), r.standings.map(x => x.value));
});

test('roster contribution equals an independent with/without full analysis, including bench filling a freed slot', () => {
  const input = league([
    [[11, { PTS: 20, AST: 2 }], [12, { PTS: 10, AST: 8 }], [13, { PTS: 30, AST: 1 }, 'bench'], [14, { PTS: 50 }, 'ir']],
    [[21, { PTS: 12 }], [22, { PTS: 12 }]],
    [[31, { PTS: 18 }], [32, { PTS: 25 }]],
  ]);
  const ev = createLeagueEvaluator(input), r = rosterContributions(ev, input.league.teams, 1, unsetGoals(), input.projections)!;
  const byId = new Map(r.players.map(p => [p.espnPlayerId, p]));
  assert.equal(byId.get(14)!.impact, null, 'IR is outside the calculation');
  // Bench player 13 never plays (two active UTIL every day): usable 0 of 2 projected games.
  assert.equal(byId.get(13)!.usableGames, 0); assert.equal(byId.get(13)!.projectedGames, 2);
  for (const id of [11, 12, 13]) {
    const without = analyzeLeague({ ...input, teams: input.league.teams.map(t => t.espnTeamId === 1 ? { ...t, roster: t.roster!.filter(p => p.espnPlayerId !== id) } : t) });
    const full = analyzeLeague(input);
    for (const c of CATEGORIES) {
      const impact = byId.get(id)!.impact!.categories.find(x => x.category === c)!;
      close(impact.delta, full.rankings[c].find(x => x.teamId === 1)!.projectedValue! - without.rankings[c].find(x => x.teamId === 1)!.projectedValue!);
      assert.equal(impact.afterRank, full.rankings[c].find(x => x.teamId === 1)!.rank);
      assert.equal(impact.beforeRank, without.rankings[c].find(x => x.teamId === 1)!.rank);
    }
  }
  // Removing active 11 lets bench 13 play: PTS falls by 20 and rises by 30 → +10 without 11.
  close(byId.get(11)!.impact!.categories.find(c => c.category === 'PTS')!.delta, 2 * 20 - 2 * 30);
  close(byId.get(13)!.impact!.categories.find(c => c.category === 'PTS')!.delta, 0);
});

test('evaluator matches analyzeLeague on every variant, re-checks ownership across teams and never mutates the source', () => {
  const input = four(), original = JSON.stringify(input), ev = createLeagueEvaluator(input);
  const variants: LeagueTeam[][] = [
    input.league.teams,
    input.league.teams.map(t => t.espnTeamId === 2 ? { ...t, roster: t.roster!.slice(1) } : t),
    // Player 11 duplicated on team 3: both owners must become incomplete.
    input.league.teams.map(t => t.espnTeamId === 3 ? { ...t, roster: [...t.roster!, input.league.teams[0].roster![0]] } : t),
    input.league.teams,
  ];
  for (const teams of variants) {
    const a = ev.evaluate(teams), b = analyzeLeague({ ...input, teams });
    assert.deepEqual({ ...a, revision: '' }, { ...b, revision: '' });
  }
  const dup = ev.evaluate(variants[2]);
  assert.equal(dup.status, 'blocked');
  assert.equal(dup.teams.find(t => t.teamId === 1)!.complete, false); assert.equal(dup.teams.find(t => t.teamId === 3)!.complete, false);
  assert.equal(ev.evaluate(variants[3]).status, 'ready', 'cache does not leak the duplicate state');
  assert.notEqual(ev.evaluate(variants[1]).revision, ev.evaluate(variants[0]).revision);
  assert.equal(ev.evaluate(variants[0]).revision, ev.evaluate(variants[3]).revision);
  const mutated = ev.evaluate(variants[0]); mutated.teams[0].warnings.push('x'); mutated.teams[0].contributions.length = 0;
  assert.deepEqual(ev.evaluate(variants[0]).teams[0].contributions.length, 2, 'results are independent copies');
  assert.equal(JSON.stringify(input), original);
});

test('before/after comparison refuses analyses from different sources or blocked leagues', () => {
  const input = four(), a = analyzeLeague(input), s = categoryStandings(a, 1, unsetGoals())!;
  assert.ok(compareTeam(a, a, 1, s, unsetGoals()));
  assert.equal(compareTeam(a, analyzeLeague({ ...input, datasetRevision: 'v2' }), 1, s, unsetGoals()), null);
  const missing = analyzeLeague({ ...input, projections: input.projections.filter(p => p.espnId !== 41) });
  assert.equal(missing.status, 'blocked'); assert.equal(compareTeam(a, missing, 1, s, unsetGoals()), null);
  assert.equal(categoryStandings(missing, 1, unsetGoals()), null, 'no standings without full league coverage');
});
