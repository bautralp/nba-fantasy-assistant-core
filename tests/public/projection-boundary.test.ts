import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticRos } from './fixtures/syntheticRos.ts';
import { parseProjections } from '../../src/features/rankings/rosProjection.ts';
import { normalizeLeague } from '../../src/infrastructure/espn/normalize.ts';
import { espnLeague } from '../helpers/espnLeagueFixture.ts';

test('hand-authored ROS preserves identity, shooting arithmetic and exact 9CAT fields', () => {
  const raw = syntheticRos(), parsed = parseProjections(raw);
  assert.equal(parsed.players.length, 3);
  assert.deepEqual(parsed.players.map(p => p.name), ['Synthetic Player 1', 'Synthetic Player 2', 'Synthetic Player 3']);
  assert.deepEqual(parsed.players.map(p => p.stats?.PTS), [6, 8, 10]);
  assert.ok(parsed.players.every(p => p.stats?.['FG%'] === 50 && p.stats?.['FT%'] === 50));
});
test('ROS rejects bad shooting, identity duplication, future mismatch and unit drift', () => {
  for (const mutate of [
    (s: ReturnType<typeof syntheticRos>) => { s.players[0].stats = { ...s.players[0].stats!, PTS: s.players[0].stats!.PTS + 1 }; },
    (s: ReturnType<typeof syntheticRos>) => { s.players[1].id = s.players[0].id; },
    (s: ReturnType<typeof syntheticRos>) => { s.players[0].eligibility.playerId = '999999'; },
    (s: ReturnType<typeof syntheticRos>) => { s.players[0].generatedAt = '2026-10-21T00:00:00Z'; },
  ]) { const raw = syntheticRos(); mutate(raw); assert.throws(() => parseProjections(raw)); }
  assert.throws(() => parseProjections({ ...syntheticRos(), unit: 'totals' }));
});
test('synthetic ESPN input is generated independently of quarantined league/roster data', () => {
  const raw = espnLeague({ id: 123 });
  const normalized = normalizeLeague(raw, 123, 2027);
  assert.equal(normalized.teams.length, 10);
  assert.ok(normalized.teams.every(t => t.roster === null));
  assert.equal(normalized.leagueId, 123);
  const bad = structuredClone(raw); bad.teams.push(bad.teams[0]);
  assert.throws(() => normalizeLeague(bad, 123, 2027));
});
