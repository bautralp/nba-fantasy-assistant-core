import { unifiedScenario, unifiedSchedule } from '../helpers/unifiedScenario.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeLeague } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { adaptCentralRos, parseAnalysisSchedule } from '../../src/seasonAnalysis/centralAdapter.ts';
import { CATEGORIES } from '../../src/seasonAnalysis/model.ts';
import { PROJECTION_STATS } from '../../src/domain/models/projection.ts';
import type { PublicLeague, LeaguePlayer } from '../../src/features/season/model.ts';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

test('extended real ten-team league: independent exhaustive lineup oracle preserves 90/90 numeric values', () => {
  const league = read('tests/fixtures/season-analysis/public-league-normalized.json') as PublicLeague;
  const schedule = parseAnalysisSchedule(unifiedSchedule);
  const scenario = unifiedScenario;
  const adapted = adaptCentralRos(scenario.projection, schedule);
  const result = analyzeLeague({ league, ...adapted, schedule, asOf: scenario.asOf, dataUpdatedAt: scenario.projection.generatedAt, lineupPolicy: 'daily-max-games' });
  assert.equal(result.status, 'ready');
  const projection = new Map(adapted.projections.map(p => [p.espnId, p]));
  const slots = league.rosterSlots.filter(s => s.slotId <= 11).flatMap(s => Array<number>(s.count).fill(s.slotId));
  function feasible(players: LeaguePlayer[], remaining: number[]): boolean {
    if (!players.length) return true;
    const sorted = [...players].sort((a,b) => remaining.filter(s => a.eligibleSlotIds!.includes(s)).length - remaining.filter(s => b.eligibleSlotIds!.includes(s)).length);
    const [first, ...rest] = sorted;
    return remaining.some((slot, i) => first.eligibleSlotIds!.includes(slot) && feasible(rest, remaining.filter((_, j) => j !== i)));
  }
  function* subsets(items: LeaguePlayer[], count: number, start = 0, chosen: LeaguePlayer[] = []): Generator<LeaguePlayer[]> {
    if (!count) { yield chosen; return; }
    for (let i = start; i <= items.length - count; i++) yield* subsets(items, count - 1, i + 1, [...chosen, items[i]]);
  }
  let verified = 0;
  for (const team of league.teams) {
    const roster = team.roster!.filter(p => p.placement !== 'ir');
    const counts = new Map<number, number>();
    for (const date of new Set(schedule.games.map(g => g.date))) {
      const nba = new Set(schedule.games.filter(g => g.date === date).flatMap(g => g.teamIds));
      const playing = roster.filter(p => nba.has(projection.get(p.espnPlayerId)!.nbaTeamId!) && projection.get(p.espnPlayerId)!.expectedGames! > 0)
        .sort((a,b) => Number(b.placement === 'active') - Number(a.placement === 'active') || a.espnPlayerId - b.espnPlayerId);
      let lineup: LeaguePlayer[] = [];
      outer: for (let size = Math.min(slots.length, playing.length); size >= 0; size--) {
        for (const subset of subsets(playing, size)) if (feasible(subset, slots)) { lineup = subset; break outer; }
      }
      for (const p of lineup) counts.set(p.espnPlayerId, (counts.get(p.espnPlayerId) ?? 0) + 1);
    }
    const totals = Object.fromEntries(PROJECTION_STATS.map(k => [k, 0])) as Record<typeof PROJECTION_STATS[number], number>;
    for (const p of roster) {
      const row = projection.get(p.espnPlayerId)!;
      const games = row.teamRemaining! > 0 ? (counts.get(p.espnPlayerId) ?? 0) * row.expectedGames! / row.teamRemaining! : 0;
      for (const k of PROJECTION_STATS) totals[k] += row.stats![k] * games;
    }
    for (const c of CATEGORIES) {
      const expected = c === 'FG%' ? 100 * totals.FGM / totals.FGA : c === 'FT%' ? 100 * totals.FTM / totals.FTA : totals[c];
      const row = result.rankings[c].find(r => r.teamId === team.espnTeamId)!;
      assert.ok(row.projectedValue !== null && Math.abs(row.projectedValue - expected) < 1e-8, `${team.espnTeamId} ${c}`);
      assert.ok(row.rank !== null && row.powerScore !== null && Number.isFinite(row.powerScore));
      verified++;
    }
  }
  assert.equal(verified, 90);
});
