import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeLeague } from '../../src/infrastructure/espn/normalize.ts';
import { normalizeDisplayPositions } from '../../src/features/season/positions.ts';
import { orderRoster, prioritizeMatchups, prioritizeTeams } from '../../src/features/season/seasonOrdering.ts';
import { standingsRows, standingsPercentage } from '../../src/features/season/standingsPresentation.ts';
const raw = () => JSON.parse(readFileSync(new URL('../fixtures/espn/category-response-shape.json', import.meta.url), 'utf8'));
function team(id: number, record: { wins: number | null; losses: number | null; ties: number | null } | null, name = `Team ${id}`) {
  return { espnTeamId: id, name, rank: 999, gamesBack: null, roster: null, record };
}
test('primary position and lineup slot IDs are separate; only specific basketball positions survive', () => {
  for (let id = 1; id <= 5; id++) {
    const positions = ['PG', 'SG', 'SF', 'PF', 'C'];
    assert.deepEqual(normalizeDisplayPositions(id, [id - 1, 5, 6, 7, 8, 9, 10, 11, 12, 13]), { primaryPosition: positions[id - 1], displayPositions: [positions[id - 1]] });
  }
  assert.deepEqual(normalizeDisplayPositions(2, [0, 1, 2, 5, 11]), { primaryPosition: 'SG', displayPositions: ['SG', 'PG', 'SF'] });
  assert.deepEqual(normalizeDisplayPositions(undefined, [0, 4, 5]), { primaryPosition: null, displayPositions: ['PG', 'C'] });
  for (const id of [undefined, null, 0, 6, 999, '1', 1.5]) assert.deepEqual(normalizeDisplayPositions(id, [5, 6, 7, 11, 13, 999]), { primaryPosition: null, displayPositions: [] });
  assert.deepEqual(normalizeDisplayPositions(5, null), { primaryPosition: 'C', displayPositions: ['C'] });
});
test('normalizer carries verified positions and GB, sanitizes invalid records, and never promotes other rank fields', () => {
  const r = raw(), p = r.teams[0].roster.entries[0].playerPoolEntry.player;
  p.defaultPositionId = 1; p.eligibleSlots = [0, 1, 5, 8, 11, 12, 13];
  r.teams[0].record.overall = { wins: 2, losses: -1, ties: 0.5, gamesBack: .5 };
  const league = normalizeLeague(r, 789, 2027);
  assert.deepEqual(league.teams[0].roster![0].displayPositions, ['PG', 'SG']); assert.equal(league.teams[0].roster![0].primaryPosition, 'PG');
  assert.deepEqual(league.teams[0].record, { wins: 2, losses: null, ties: null }); assert.equal(league.teams[0].gamesBack, .5);
  assert.equal(standingsRows(league.teams)[0].rank, null);
  p.defaultPositionId = undefined; p.eligibleSlots = null;
  assert.deepEqual(normalizeLeague(r, 789, 2027).teams[0].roster![0].displayPositions, []);
});
test('rosters are grouped guard, forward, center, unknown once; views do not mutate ownership or source order', () => {
  const p = normalizeLeague(raw(), 789, 2027).teams[0].roster![0];
  const players = [
    { ...p, espnPlayerId: 1, name: 'Center', ...normalizeDisplayPositions(5, [4, 11]) },
    { ...p, espnPlayerId: 2, name: 'Unknown', ...normalizeDisplayPositions(null, [6, 12]) },
    { ...p, espnPlayerId: 3, name: 'Forward', ...normalizeDisplayPositions(3, [2, 3]) },
    { ...p, espnPlayerId: 4, name: 'Multi guard', ...normalizeDisplayPositions(5, [0, 4]) },
    { ...p, espnPlayerId: 5, name: 'Guard', ...normalizeDisplayPositions(1, [0, 1]) },
  ];
  players.forEach(Object.freeze); Object.freeze(players);
  assert.deepEqual(orderRoster(players).map(p => p.espnPlayerId), [5, 4, 3, 1, 2]);
  assert.equal(new Set(orderRoster(players).map(p => p.espnPlayerId)).size, 5);
  assert.deepEqual(players.map(p => p.espnPlayerId), [1, 2, 3, 4, 5]);
});
test('selected team and matchup come first in a stable partition, including every week and changed selection', () => {
  const teams = Object.freeze([team(1, null), team(2, null), team(3, null), team(4, null)]);
  assert.deepEqual(prioritizeTeams(teams, 3).map(t => t.espnTeamId), [3, 1, 2, 4]);
  assert.deepEqual(prioritizeTeams(teams, 2).map(t => t.espnTeamId), [2, 1, 3, 4]);
  const side = normalizeLeague(raw(), 789, 2027).matchups![0].home!;
  for (const week of [1, 4, 7]) {
    const matches = Object.freeze([{ matchupPeriodId: week, home: { ...side, teamId: 3 }, away: { ...side, teamId: 4 } }, { matchupPeriodId: week, home: { ...side, teamId: 1 }, away: { ...side, teamId: 2 } }]);
    assert.equal(prioritizeMatchups(matches, 1)[0], matches[1]); assert.equal(prioritizeMatchups(matches, 4)[0], matches[0]); assert.equal(matches[0].home.teamId, 3);
  }
});
test('standings percentages include half ties, exact ties share competition rank, alphabetical order is visual only', () => {
  const teams = Object.freeze([team(1, { wins: 1, losses: 1, ties: 0 }, 'Z'), team(2, { wins: 2, losses: 2, ties: 0 }, 'A'), team(3, { wins: 1, losses: 0, ties: 1 }, 'B'), team(4, { wins: 0, losses: 0, ties: 0 }), team(5, null), team(6, { wins: 1, losses: null, ties: 0 })]);
  const rows = standingsRows(teams);
  assert.deepEqual(rows.filter(r => r.rank !== null).map(r => [r.team.espnTeamId, r.rank, r.tied]), [[3, 1, false], [2, 2, true], [1, 2, true]]);
  assert.equal(rows[0].played, 2); assert.equal(rows[0].winPercentage, .75); assert.equal(standingsPercentage(rows[0].winPercentage), '75,0%');
  assert.ok(rows.slice(3).every(r => r.rank === null && r.winPercentage === null));
  assert.equal(rows.find(r => r.team.espnTeamId === 4)!.played, 0); assert.equal(rows.find(r => r.team.espnTeamId === 5)!.played, null);
  const loser = standingsRows([team(10, { wins: 0, losses: 1, ties: 0 })])[0];
  assert.equal(loser.winPercentage, 0); assert.equal(loser.rank, 1); assert.equal(standingsPercentage(loser.winPercentage), '0,0%');
  assert.equal(standingsPercentage(null), '—'); assert.equal(teams[0].espnTeamId, 1);
  const allZero = standingsRows(Array.from({ length: 10 }, (_, i) => team(i, { wins: 0, losses: 0, ties: 0 })));
  assert.ok(allZero.every(r => r.rank === null && r.winPercentage === null && r.played === 0));
  const ranks = standingsRows([team(1, { wins: 2, losses: 0, ties: 0 }), team(2, { wins: 2, losses: 0, ties: 0 }), team(3, { wins: 1, losses: 1, ties: 0 })]);
  assert.deepEqual(ranks.map(r => r.rank), [1, 1, 3]);
});
