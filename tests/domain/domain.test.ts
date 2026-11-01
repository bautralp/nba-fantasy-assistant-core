import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_TARGETS, NINE_CATEGORIES, createUnsetTargets } from '../../src/domain/models/categories.ts';
import type { CategoryTargets } from '../../src/domain/models/categories.ts';
import type { DraftSession } from '../../src/domain/models/draft.ts';
import type { PlayerProjection, ProjectionDataset, ProjectionStats } from '../../src/domain/models/projection.ts';
import type { Position } from '../../src/domain/models/roster.ts';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';
import { appendDraftPick, changeDraftOrder, deriveDraftRoster, removeDraftPick, snakeTeamAt } from '../../src/domain/rules/draftRules.ts';
import { INITIAL_LEAGUE_RULES, totalDraftPicks } from '../../src/domain/rules/leagueRules.ts';
import { validateWorkspace } from '../../src/domain/rules/invariants.ts';
import type { IntegrityCode } from '../../src/domain/rules/invariants.ts';

const fresh = () => createInitialWorkspace({ leagueId: 'league', season: '2026-27', teamIds: Array.from({ length: 10 }, (_, i) => `team-${i + 20}`), draftSessionId: 'draft' });
const stats: ProjectionStats = { FGM: 5, FGA: 10, FTM: 3, FTA: 4, '3PM': 2, PTS: 15, REB: 6, AST: 4, STL: 1, BLK: 1, TO: 2 };
const dataset: ProjectionDataset = { id: 'data', schemaVersion: 1, season: '2026-27', source: { name: 'Test source', kind: 'json' }, importedAt: '2026-10-20T12:00:00Z', unit: 'perGame' };
const projection: PlayerProjection = { playerId: 'p-1', datasetId: 'data', status: 'valid', gamesPlayed: 65.5, stats };
function populated(): WorkspaceSnapshot {
  const snapshot = fresh();
  return { ...snapshot, players: [{ id: 'p-1', name: 'Same name' }, { id: 'p-2', name: 'Same name' }], datasets: [dataset], projections: [projection], league: { ...snapshot.league, activeDatasetId: 'data' } };
}
function session(snapshot: WorkspaceSnapshot): DraftSession {
  assert.ok(snapshot.draftSession);
  return snapshot.draftSession;
}
function has(snapshot: WorkspaceSnapshot, code: IntegrityCode) {
  assert.ok(validateWorkspace(snapshot).some(issue => issue.code === code), `${code}: ${JSON.stringify(validateWorkspace(snapshot))}`);
}

test('empty initial league has no names, players or assignments and every target is unset', () => {
  const snapshot = fresh();
  assert.deepEqual(validateWorkspace(snapshot), []);
  assert.equal(snapshot.league.name, '');
  assert.equal(snapshot.league.userTeamId, null);
  assert.ok(snapshot.teams.every(team => team.name === ''));
  assert.deepEqual(snapshot.players, []);
  assert.deepEqual(session(snapshot).picks, []);
  assert.ok(snapshot.strategies.every(strategy => Object.values(strategy.targets).every(target => target === 'unset')));
  assert.notEqual(snapshot.strategies[0].targets, snapshot.strategies[1].targets);
});

test('initial rules are immutable 10-team, 13-player, 9-category snake rules', () => {
  assert.equal(totalDraftPicks(INITIAL_LEAGUE_RULES), 130);
  assert.equal(INITIAL_LEAGUE_RULES.rosterSlots.length, 13);
  assert.deepEqual(INITIAL_LEAGUE_RULES.categories, NINE_CATEGORIES);
  assert.ok(Object.isFrozen(INITIAL_LEAGUE_RULES));
  assert.ok(Object.isFrozen(INITIAL_LEAGUE_RULES.categories));
  assert.ok(Object.isFrozen(INITIAL_LEAGUE_RULES.rosterSlots));
  for (const rules of [
    { ...INITIAL_LEAGUE_RULES, teamCount: 12 },
    { ...INITIAL_LEAGUE_RULES, rosterSize: 14 },
    { ...INITIAL_LEAGUE_RULES, categories: NINE_CATEGORIES.slice(1) },
  ]) has({ ...fresh(), league: { ...fresh().league, rules } }, 'unsupported-rules');
});

test('constructor rejects missing or duplicate IDs and unsupported initial team count', () => {
  for (const teamIds of [[], Array(10).fill('same'), [...fresh().teams.map(team => team.id).slice(1), '']]) {
    assert.throws(() => createInitialWorkspace({ leagueId: 'l', season: '2026-27', draftSessionId: 'd', teamIds }));
  }
});

test('category keys and all six targets are checked at compile time and runtime', () => {
  const targets: CategoryTargets = createUnsetTargets();
  // @ts-expect-error Unknown category must not be accepted.
  const invalidKey: keyof CategoryTargets = 'GP';
  // @ts-expect-error Unsupported target must not be accepted.
  const invalidTarget: CategoryTargets['PTS'] = 'top2';
  void invalidKey; void invalidTarget;
  assert.equal(Object.keys(targets).length, 9);
  for (const target of CATEGORY_TARGETS) {
    const snapshot = fresh();
    assert.deepEqual(validateWorkspace({ ...snapshot, strategies: [{ ...snapshot.strategies[0], targets: { ...targets, PTS: target } }] }), []);
  }
  has({ ...fresh(), strategies: [{ ...fresh().strategies[0], targets: { ...targets, PTS: 'top2' } as unknown as CategoryTargets }] }, 'invalid-value');
  const { TO: _removed, ...missing } = targets;
  void _removed;
  has({ ...fresh(), strategies: [{ ...fresh().strategies[0], targets: missing as CategoryTargets }] }, 'invalid-value');
});

test('same-name players have independent identities across datasets, units and renamed players', () => {
  const snapshot = populated();
  const other: ProjectionDataset = { ...dataset, id: 'api-data', unit: 'totals', source: { name: 'API', kind: 'api' } };
  const value: WorkspaceSnapshot = { ...snapshot, players: [{ id: 'p-1', name: 'Renamed' }, snapshot.players[1]], datasets: [dataset, other], projections: [projection, { ...projection, datasetId: other.id }, { ...projection, playerId: 'p-2' }] };
  assert.deepEqual(validateWorkspace(value), []);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(value)) as WorkspaceSnapshot), []);
  has({ ...value, projections: [...value.projections, projection] }, 'duplicate-id');
});

test('eligibility varies by league, dataset and season without changing Player', () => {
  const snapshot = populated();
  const older = { ...dataset, id: 'old-data', season: '2025-26', source: { name: 'Workbook', kind: 'excel' as const } };
  const value: WorkspaceSnapshot = { ...snapshot, datasets: [dataset, older], eligibility: [
    { playerId: 'p-1', season: snapshot.league.season, scope: { kind: 'league', leagueId: snapshot.league.id }, positions: [] },
    { playerId: 'p-1', season: dataset.season, scope: { kind: 'dataset', datasetId: dataset.id }, positions: ['PG', 'SG'] },
    { playerId: 'p-1', season: older.season, scope: { kind: 'dataset', datasetId: older.id }, positions: ['SF'] },
  ] };
  assert.deepEqual(validateWorkspace(value), []);
  assert.equal('positions' in value.players[0], false);
  has({ ...value, eligibility: [...value.eligibility, value.eligibility[0]] }, 'duplicate-id');
  has({ ...value, eligibility: [{ ...value.eligibility[0], season: 'wrong' }] }, 'invalid-reference');
});

test('all 130 snake positions preserve team IDs and give every team 13 picks', () => {
  const snapshot = fresh();
  const order = [...session(snapshot).draftOrder].reverse();
  const expected = Array.from({ length: 13 }, (_, round) => round % 2 === 0 ? order : [...order].reverse()).flat();
  const actual = expected.map((_, index) => snakeTeamAt(order, index, snapshot.league.rules));
  assert.deepEqual(actual, expected);
  for (const id of order) assert.equal(actual.filter(team => team === id).length, 13);
  for (const index of [-1, 0.5, NaN, 130, 131]) assert.equal(snakeTeamAt(order, index, snapshot.league.rules), null);
});

test('order accepts a permutation before draft and is locked after the first selection', () => {
  const draft = session(fresh());
  const order = [...draft.draftOrder].reverse();
  const changed = changeDraftOrder(draft, order);
  assert.deepEqual(changed.draftOrder, order);
  assert.notDeepEqual(draft.draftOrder, order);
  order.reverse();
  assert.notDeepEqual(changed.draftOrder, order);
  assert.throws(() => changeDraftOrder(draft, Array(10).fill(draft.draftOrder[0])));
  assert.throws(() => changeDraftOrder({ ...draft, status: 'inProgress', picks: [{ teamId: draft.draftOrder[0], playerId: 'p-1' }] }, order));
});

test('draft order must contain each league team once', () => {
  const snapshot = fresh();
  for (const order of [[], Array(10).fill(snapshot.teams[0].id), [...session(snapshot).draftOrder.slice(1), 'missing']]) {
    has({ ...snapshot, draftSession: { ...session(snapshot), draftOrder: order } }, 'draft-order');
  }
});

test('draft picks derive the roster and out-of-turn selections require explicit confirmation', () => {
  const snapshot = populated();
  const draft: DraftSession = { ...session(snapshot), status: 'inProgress', picks: [{ playerId: 'p-1', teamId: snapshot.teams[1].id }] };
  has({ ...snapshot, draftSession: draft }, 'out-of-turn');
  const accepted = { ...draft, picks: [{ ...draft.picks[0], outOfTurnConfirmed: true }] };
  assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: accepted }), []);
  assert.deepEqual(deriveDraftRoster(accepted), [{ playerId: 'p-1', teamId: snapshot.teams[1].id }]);
  has({ ...snapshot, draftSession: accepted, rosterEntries: deriveDraftRoster(accepted) }, 'roster-source');
});

test('duplicate selections across teams and within the same team are rejected', () => {
  const snapshot = populated();
  for (const teamId of [snapshot.teams[0].id, snapshot.teams[1].id]) {
    const picks = [{ playerId: 'p-1', teamId: snapshot.teams[0].id }, { playerId: 'p-1', teamId, outOfTurnConfirmed: true }];
    has({ ...snapshot, draftSession: { ...session(snapshot), status: 'inProgress', picks } }, 'duplicate-player');
    has({ ...snapshot, draftSession: null, rosterEntries: picks }, 'duplicate-player');
  }
});

test('13-player boundary and capacity apply to standalone rosters and draft picks', () => {
  const snapshot = fresh();
  const players = Array.from({ length: 14 }, (_, index) => ({ id: `p-${index}`, name: `Synthetic ${index}` }));
  const picks = players.map(player => ({ playerId: player.id, teamId: snapshot.teams[0].id, outOfTurnConfirmed: true }));
  assert.deepEqual(validateWorkspace({ ...snapshot, players, draftSession: null, rosterEntries: picks.slice(0, 13) }), []);
  has({ ...snapshot, players, draftSession: null, rosterEntries: picks }, 'team-capacity');
  has({ ...snapshot, players, draftSession: { ...session(snapshot), status: 'inProgress', picks } }, 'team-capacity');
});

test('reference validation covers every relationship', () => {
  const snapshot = populated();
  const cases: WorkspaceSnapshot[] = [
    { ...snapshot, league: { ...snapshot.league, activeDatasetId: 'missing' } },
    { ...snapshot, league: { ...snapshot.league, userTeamId: 'missing' } },
    { ...snapshot, teams: [{ ...snapshot.teams[0], leagueId: 'missing' }, ...snapshot.teams.slice(1)] },
    { ...snapshot, projections: [{ ...projection, playerId: 'missing' }] },
    { ...snapshot, projections: [{ ...projection, datasetId: 'missing' }] },
    { ...snapshot, strategies: [{ ...snapshot.strategies[0], teamId: 'missing' }] },
    { ...snapshot, strategies: [{ ...snapshot.strategies[0], leagueId: 'missing' }] },
    { ...snapshot, draftSession: { ...session(snapshot), leagueId: 'missing' } },
    { ...snapshot, draftSession: null, rosterEntries: [{ playerId: 'missing', teamId: 'missing' }] },
    { ...snapshot, eligibility: [{ playerId: 'missing', season: dataset.season, scope: { kind: 'dataset', datasetId: 'missing' }, positions: [] }] },
  ];
  cases.forEach(value => has(value, 'invalid-reference'));
});

test('duplicate entity IDs and team strategies are rejected', () => {
  const snapshot = populated();
  for (const value of [
    { ...snapshot, players: [...snapshot.players, snapshot.players[0]] },
    { ...snapshot, datasets: [dataset, dataset] },
    { ...snapshot, teams: [...snapshot.teams.slice(0, 9), snapshot.teams[0]] },
    { ...snapshot, strategies: [snapshot.strategies[0], snapshot.strategies[0]] },
  ]) has(value, 'duplicate-id');
});

test('projection validation accepts decimal GP, zero shot volume and excluded rows', () => {
  const snapshot = populated();
  assert.deepEqual(validateWorkspace(snapshot), []);
  assert.deepEqual(validateWorkspace({ ...snapshot, projections: [{ ...projection, stats: { ...stats, FGM: 0, FGA: 0, FTM: 0, FTA: 0 } }] }), []);
  const excluded: PlayerProjection = { playerId: 'p-1', datasetId: 'data', status: 'excluded', reasons: ['Missing GP'] };
  assert.deepEqual(validateWorkspace({ ...snapshot, projections: [excluded], draftSession: null, rosterEntries: [{ teamId: snapshot.teams[0].id, playerId: 'p-1' }] }), []);
  for (const gamesPlayed of [0, -1, NaN, Infinity]) has({ ...snapshot, projections: [{ ...projection, gamesPlayed }] }, 'invalid-value');
  for (const invalid of [{ ...stats, FGM: 11 }, { ...stats, FTM: 5 }, { ...stats, TO: -1 }, { ...stats, AST: Infinity }]) has({ ...snapshot, projections: [{ ...projection, stats: invalid }] }, 'invalid-value');
  has({ ...snapshot, projections: [{ ...excluded, reasons: [] }] }, 'invalid-value');
});

test('full draft is valid only as completed, with no next selection', () => {
  const snapshot = fresh();
  const players = Array.from({ length: 130 }, (_, i) => ({ id: `p-${i}`, name: `Synthetic ${i}` }));
  const picks = players.map((player, index) => ({ playerId: player.id, teamId: snakeTeamAt(session(snapshot).draftOrder, index, snapshot.league.rules)! }));
  const draft: DraftSession = { ...session(snapshot), status: 'completed', picks };
  assert.deepEqual(validateWorkspace({ ...snapshot, players, draftSession: draft }), []);
  has({ ...snapshot, players, draftSession: { ...draft, status: 'inProgress' } }, 'draft-status');
  has({ ...snapshot, draftSession: { ...session(snapshot), status: 'completed' } }, 'draft-status');
  has({ ...snapshot, draftSession: { ...session(snapshot), status: 'inProgress' } }, 'draft-status');
});

test('validation is pure and returns paths for actionable diagnostics', () => {
  const snapshot = populated();
  const before = JSON.stringify(snapshot);
  validateWorkspace(snapshot);
  assert.equal(JSON.stringify(snapshot), before);
  const issues = validateWorkspace({ ...snapshot, league: { ...snapshot.league, activeDatasetId: 'missing' } });
  assert.ok(issues.some(issue => issue.path === 'league.activeDatasetId'));
});

test('schema versions, dataset metadata and eligibility values are validated', () => {
  const snapshot = populated();
  has({ ...snapshot, schemaVersion: 2 } as unknown as WorkspaceSnapshot, 'unsupported-schema');
  has({ ...snapshot, datasets: [{ ...dataset, schemaVersion: 2 }] } as unknown as WorkspaceSnapshot, 'unsupported-schema');
  has({ ...snapshot, datasets: [{ ...dataset, importedAt: 'invalid' }] }, 'invalid-value');
  has({ ...snapshot, datasets: [{ ...dataset, season: '2025-26' }] }, 'invalid-reference');
  has({ ...snapshot, eligibility: [{ playerId: 'p-1', season: dataset.season, scope: { kind: 'dataset', datasetId: 'data' }, positions: ['PG', 'PG'] }] }, 'invalid-value');
  has({ ...snapshot, projections: [{ ...projection, rank: 0 }] }, 'invalid-value');
});

test('draft status rejects setup with picks and overflowing selections', () => {
  const snapshot = populated();
  const pick = { playerId: 'p-1', teamId: snapshot.teams[0].id, outOfTurnConfirmed: true };
  has({ ...snapshot, draftSession: { ...session(snapshot), picks: [pick] } }, 'draft-status');
  has({ ...snapshot, draftSession: { ...session(snapshot), status: 'completed', picks: Array(131).fill(pick) } }, 'draft-status');
});

function draftWithPicks(count: number): WorkspaceSnapshot {
  const snapshot = fresh();
  const players = Array.from({ length: count + 1 }, (_, index) => ({ id: `p-${index}`, name: `Synthetic ${index}` }));
  // Deliberately exercise the original PR's records without selectionIndex as well.
  const picks = players.slice(0, count).map((player, index) => ({ playerId: player.id, teamId: snakeTeamAt(session(snapshot).draftOrder, index, snapshot.league.rules)! }));
  return { ...snapshot, players, draftSession: { ...session(snapshot), picks, status: count === 130 ? 'completed' : 'inProgress' } };
}

test('removing an early or middle pick preserves ownership across snake rounds without inventing consent', () => {
  for (const removedIndex of [0, 5, 9, 10, 19, 22]) {
    const snapshot = draftWithPicks(23);
    const draft = session(snapshot);
    const before = JSON.stringify(snapshot);
    const updated = removeDraftPick(draft, draft.picks[removedIndex].playerId);
    assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: updated }), []);
    assert.deepEqual(deriveDraftRoster(updated), deriveDraftRoster(draft).filter((_, index) => index !== removedIndex));
    assert.deepEqual(updated.picks.map(pick => pick.selectionIndex), draft.picks.map((_, index) => index).filter(index => index !== removedIndex));
    assert.ok(updated.picks.every(pick => pick.outOfTurnConfirmed === undefined));
    assert.equal(snakeTeamAt(updated.draftOrder, updated.picks.length, snapshot.league.rules), draft.draftOrder[2]);
    assert.equal(JSON.stringify(snapshot), before);
  }
});

test('after repeated deletions new picks use remaining count and still require out-of-turn consent', () => {
  const snapshot = draftWithPicks(23);
  const rules = snapshot.league.rules;
  const removedTwice = removeDraftPick(removeDraftPick(session(snapshot), 'p-0'), 'p-5');
  assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: removedTwice }), []);
  const expected = snakeTeamAt(removedTwice.draftOrder, removedTwice.picks.length, rules)!;
  const other = removedTwice.draftOrder.find(id => id !== expected)!;
  const next = appendDraftPick(removedTwice, { playerId: 'p-23', teamId: expected }, rules);
  assert.equal(next.picks.at(-1)?.selectionIndex, 21);
  assert.equal(next.picks.at(-1)?.outOfTurnConfirmed, undefined);
  assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: next }), []);
  // A recorded historical index is not a global or session-wide exemption.
  assert.throws(() => appendDraftPick(removedTwice, { playerId: 'p-23', teamId: other }, rules), /confirmation/);
  const invalid: DraftSession = { ...removedTwice, picks: [...removedTwice.picks, { playerId: 'p-23', teamId: other }] };
  has({ ...snapshot, draftSession: invalid }, 'out-of-turn');
  const confirmed = appendDraftPick(removedTwice, { playerId: 'p-23', teamId: other, outOfTurnConfirmed: true }, rules);
  assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: confirmed }), []);
  const afterAnotherDeletion = removeDraftPick(confirmed, 'p-1');
  assert.equal(afterAnotherDeletion.picks.at(-1)?.outOfTurnConfirmed, true);
  assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: afterAnotherDeletion }), []);
});

test('deletion does not legitimize a previously unconfirmed assignment', () => {
  const snapshot = draftWithPicks(3);
  const draft = session(snapshot);
  const invalid = { ...draft, picks: [draft.picks[0], { ...draft.picks[1], teamId: draft.draftOrder[7] }, draft.picks[2]] };
  const updated = removeDraftPick(invalid, 'p-0');
  has({ ...snapshot, draftSession: updated }, 'out-of-turn');
  assert.equal(updated.picks[0].outOfTurnConfirmed, undefined);
});

test('historical turn indices must be finite integers within draft bounds even with consent', () => {
  const snapshot = draftWithPicks(1);
  for (const selectionIndex of [-1, 0.5, NaN, Infinity, 130]) {
    has({ ...snapshot, draftSession: { ...session(snapshot), picks: [{ ...session(snapshot).picks[0], selectionIndex, outOfTurnConfirmed: true }] } }, 'invalid-value');
  }
});

test('removing from completed draft reopens it; last removal returns to empty setup', () => {
  const snapshot = draftWithPicks(130);
  const updated = removeDraftPick(session(snapshot), 'p-0');
  assert.equal(updated.status, 'inProgress');
  assert.deepEqual(validateWorkspace({ ...snapshot, draftSession: updated }), []);
  assert.equal(snakeTeamAt(updated.draftOrder, updated.picks.length, snapshot.league.rules), updated.draftOrder[9]);
  const single = draftWithPicks(1);
  const empty = removeDraftPick(session(single), 'p-0');
  assert.equal(empty.status, 'setup');
  assert.deepEqual(validateWorkspace({ ...single, draftSession: empty }), []);
});

test('general G and F eligibility tokens survive validation and JSON without expansion', () => {
  const snapshot = populated();
  for (const positions of [['G'], ['F'], ['G', 'F'], ['PG', 'G'], ['SF', 'F']] as const) {
    const value: WorkspaceSnapshot = { ...snapshot, eligibility: [{ playerId: 'p-1', season: dataset.season, scope: { kind: 'dataset', datasetId: dataset.id }, positions }] };
    assert.deepEqual(validateWorkspace(value), []);
    const restored = JSON.parse(JSON.stringify(value)) as WorkspaceSnapshot;
    assert.deepEqual(restored.eligibility[0].positions, positions);
    assert.deepEqual(validateWorkspace(restored), []);
  }
  const guard: readonly Position[] = ['G'];
  const forward: readonly Position[] = ['F'];
  assert.ok(!guard.includes('PG') && !guard.includes('SG'));
  assert.ok(!forward.includes('SF') && !forward.includes('PF'));
  has({ ...snapshot, eligibility: [{ playerId: 'p-1', season: dataset.season, scope: { kind: 'dataset', datasetId: dataset.id }, positions: ['G', 'G'] }] }, 'invalid-value');
  has({ ...snapshot, eligibility: [{ playerId: 'p-1', season: dataset.season, scope: { kind: 'league', leagueId: snapshot.league.id }, positions: ['F', 'F'] }] }, 'invalid-value');
});
