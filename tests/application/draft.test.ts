import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import type { ProjectionStats } from '../../src/domain/models/projection.ts';
import { fresh } from '../helpers/draftFixture.ts';
import { changeDraftOrder } from '../../src/domain/rules/draftRules.ts';
import { validateWorkspace } from '../../src/domain/rules/invariants.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { draftStatus, selectDraftWorkspace, resolveEligibility, projectionValue } from '../../src/application/draftSelectors.ts';
import { WorkspaceStore } from '../../src/application/workspaceStore.ts';
import { restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';

const pick = (w: WorkspaceSnapshot, i: number, teamId = draftStatus(w).teamId!, confirmed = false) => applyDraftCommand(w, { kind: 'assign', playerId: `p${i}`, teamId, confirmed });
const targets = { 'FG%': 'top1', 'FT%': 'top3', '3PM': 'top5', PTS: 'top7', REB: 'punt', AST: 'unset', STL: 'top1', BLK: 'top5', TO: 'top3' } as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

test('first pick, snake reversal at 10/11 and complete 130/131 bounds use domain turns', () => {
  let w = fresh(); assert.equal(draftStatus(w).teamId, 't0');
  for (let i = 0; i < 130; i++) {
    if (i === 9 || i === 10) assert.equal(draftStatus(w).teamId, 't9');
    w = pick(w, i);
  }
  assert.deepEqual(draftStatus(w), { count: 130, total: 130, completed: true, next: null, round: null, teamId: null, userPosition: 1 });
  assert.equal(validateWorkspace(w).length, 0); assert.throws(() => pick(w, 130, 't0'));
  assert.throws(() => changeDraftOrder(w.draftSession!, [...w.draftSession!.draftOrder].reverse()));
});
test('assignment is pure, rejects unknown/duplicate/full teams and records explicit consent', () => {
  const original = freeze(fresh()), before = JSON.stringify(original);
  assert.throws(() => pick(original, 0, 't2'));
  assert.throws(() => pick(original, 0, 'unknown', true));
  assert.throws(() => applyDraftCommand(original, { kind: 'assign', playerId: 'unknown', teamId: 't0' }));
  const w = pick(original, 0, 't2', true);
  assert.equal(w.draftSession!.picks[0].outOfTurnConfirmed, true);
  assert.throws(() => pick(w, 0, 't1', true)); assert.equal(JSON.stringify(original), before);
  let full = original; for (let i = 0; i < 13; i++) full = pick(full, i, 't1', true);
  assert.throws(() => pick(full, 13, 't1', true));
  full = pick(full, 13, 't2', true);
  assert.throws(() => applyDraftCommand(full, { kind: 'transfer', playerId: 'p13', teamId: 't1', confirmed: true }));
});
test('transfer preserves chronology and historical indices; old consent cannot authorize new owner', () => {
  let w = fresh(); for (let i = 0; i < 12; i++) w = pick(w, i);
  w = applyDraftCommand(w, { kind: 'transfer', playerId: 'p3', teamId: 't8', confirmed: true });
  const before = freeze(w), previous = w.draftSession!.picks;
  assert.throws(() => applyDraftCommand(w, { kind: 'transfer', playerId: 'p3', teamId: 't7' }));
  const moved = applyDraftCommand(w, { kind: 'transfer', playerId: 'p3', teamId: 't7', confirmed: true });
  assert.equal(moved.draftSession!.picks[3].selectionIndex, 3); assert.equal(moved.draftSession!.picks.length, 12);
  assert.deepEqual(moved.draftSession!.picks.filter(p => p.playerId !== 'p3'), previous.filter(p => p.playerId !== 'p3'));
  const returned = applyDraftCommand(moved, { kind: 'transfer', playerId: 'p3', teamId: 't3' });
  assert.equal(returned.draftSession!.picks[3].outOfTurnConfirmed, undefined); assert.equal(validateWorkspace(before).length, 0);
});
test('legacy implicit indices materialize on transfer and deletion without renumbering', () => {
  let w = fresh(); for (let i = 0; i < 12; i++) w = pick(w, i);
  w = { ...w, draftSession: { ...w.draftSession!, picks: w.draftSession!.picks.map(({ selectionIndex: _index, ...p }) => p) } };
  w = applyDraftCommand(w, { kind: 'transfer', playerId: 'p4', teamId: 't8', confirmed: true });
  w = applyDraftCommand(w, { kind: 'remove', playerId: 'p2' });
  assert.deepEqual(w.draftSession!.picks.map(p => p.selectionIndex), [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const before = w.draftSession!.picks.slice(0, -1);
  assert.throws(() => applyDraftCommand(w, { kind: 'undo', playerId: 'p0' }));
  w = applyDraftCommand(w, { kind: 'undo', playerId: 'p11' });
  assert.deepEqual(w.draftSession!.picks, before); assert.equal(draftStatus(w).teamId, 't9');
});
test('atomic integrity rejection leaves original untouched', () => {
  const w = fresh(); const invalid = { ...w, teams: w.teams.slice(1) }; const before = JSON.stringify(invalid);
  assert.throws(() => pick(invalid, 0)); assert.equal(JSON.stringify(invalid), before);
});
test('strategy changes only current team and computations never enter JSON', () => {
  const w = freeze(fresh()), next = applyDraftCommand(w, { kind: 'strategy', targets });
  assert.deepEqual(next.strategies.filter(s => s.teamId !== 't0'), w.strategies.filter(s => s.teamId !== 't0'));
  assert.notEqual(next.strategies.find(s => s.teamId === 't0')!.targets, targets);
  const before = JSON.stringify(next); const v = selectDraftWorkspace(next);
  assert.equal(v.topFive.length, 5); assert.equal(JSON.stringify(next), before);
  const drafted = pick(next, Number(v.topFive[0].playerId.slice(1)));
  assert.ok(!selectDraftWorkspace(drafted).topFive.some(p => p.playerId === v.topFive[0].playerId));
  assert.ok(restoreWorkspaceJson(JSON.stringify(drafted)).ok);
});
test('all empty recommendation states remain distinct and fewer than five is not padded', () => {
  const w = fresh(3);
  assert.match(selectDraftWorkspace({ ...w, league: { ...w.league, activeDatasetId: null } }).empty, /dosyası/);
  assert.match(selectDraftWorkspace({ ...w, projections: [] }).empty, /geçerli projeksiyon yok/);
  assert.match(selectDraftWorkspace(w).empty, /belirlenmedi/);
  const punt = Object.fromEntries(Object.keys(targets).map(k => [k, 'punt'])) as typeof w.strategies[number]['targets'];
  assert.match(selectDraftWorkspace(applyDraftCommand(w, { kind: 'strategy', targets: punt })).empty, /unset\/punt/);
  let active = applyDraftCommand(w, { kind: 'strategy', targets });
  assert.equal(selectDraftWorkspace(active).topFive.length, 3);
  for (let i = 0; i < 3; i++) active = pick(active, i);
  assert.match(selectDraftWorkspace(active).empty, /aday kalmadı/);
  let full = applyDraftCommand(fresh(), { kind: 'strategy', targets });
  for (let i = 0; i < 13; i++) full = pick(full, i, 't0', true);
  assert.match(selectDraftWorkspace(full).empty, /kadrosu dolu/);
  for (let i = 13; i < 130; i++) { const available = full.teams.find(t => full.draftSession!.picks.filter(p => p.teamId === t.id).length < 13)!; full = pick(full, i, available.id, true); }
  assert.equal(selectDraftWorkspace(full).empty, 'Draft tamamlandı.');
});
test('active dataset isolation, missing/excluded ownership and scoped G/F eligibility', () => {
  let w = pick(fresh(4), 0);
  w = { ...w, projections: w.projections.filter(p => p.playerId !== 'p0').map(p => p.playerId === 'p1' ? { playerId: p.playerId, datasetId: p.datasetId, status: 'excluded' as const, reasons: ['bad'] } : p), eligibility: [...w.eligibility, { playerId: 'p2', season: 'fixture', scope: { kind: 'league', leagueId: 'league' }, positions: ['F'] }] };
  const v = selectDraftWorkspace(w);
  assert.equal(v.ownership.get('p0'), 't0'); assert.ok(v.pool.some(p => p.id === 'p0'));
  assert.equal(v.model!.z.has('p0'), false); assert.equal(v.model!.z.has('p1'), false);
  assert.deepEqual(v.positions.get('p2'), ['F']); assert.deepEqual(v.positions.get('p3'), ['G']);
  const updated = { ...w, datasets: [...w.datasets, { ...w.datasets[0], id: 'new' }], league: { ...w.league, activeDatasetId: 'new' } };
  assert.equal(selectDraftWorkspace(updated).model!.usable, false); assert.deepEqual(updated.draftSession, w.draftSession);
  assert.deepEqual(resolveEligibility(updated).find(p => p.playerId === 'p3')!.positions, []);
});
test('statistics preserve raw perGame/totals units, calculate percentages and omit zero attempts/excluded', () => {
  const p = fresh(1).projections[0]; assert.equal(projectionValue(p, 'FG%'), .5); assert.equal(projectionValue(p, 'FT%'), .75);
  const v = selectDraftWorkspace(fresh(1)); assert.equal(v.totals.get('p0')!.stats.PTS, 600);
  const w = fresh(1), totals = { ...w, datasets: [{ ...w.datasets[0], unit: 'totals' as const }], projections: [{ ...p, status: 'valid' as const, gamesPlayed: 60, stats: v.totals.get('p0')!.stats }] };
  assert.equal(projectionValue(totals.projections[0], 'PTS'), 600); assert.equal(projectionValue(totals.projections[0], 'FG%'), .5);
  assert.equal(projectionValue({ ...p, status: 'valid', gamesPlayed: 60, stats: { FGM: 0, FGA: 0 } as ProjectionStats }, 'FG%'), null);
  assert.equal(projectionValue({ playerId: 'p', datasetId: 'data', status: 'excluded', reasons: ['bad'] }, 'PTS'), null);
});
test('store accept failure cannot apply picks; quota failure retains memory and round-trippable backup', async () => {
  const store = new WorkspaceStore({ load: async () => ({ ok: true, value: fresh() }), save: async () => ({ ok: false, error: { code: 'storage-quota' } }) });
  assert.equal(store.accept(fresh()), false); await store.load();
  const next = pick(store.getSnapshot().workspace!, 0); assert.equal(store.accept(next), true); await store.save();
  assert.equal(store.getSnapshot().workspace, next); assert.equal(store.getSnapshot().dirty, true);
  const restored = restoreWorkspaceJson(JSON.stringify(next)); assert.ok(restored.ok); assert.deepEqual(restored.value, next);
});

// Boundary adapter uses frozen v3.3 fromObjects output and expected suggestions, never new-engine output.
for (const name of ['empty-rosters', 'early', 'middle', 'late', 'last-pick', 'all-unset', 'all-punt']) test(`application selector preserves frozen v3.3 recommendation order: ${name}`, () => {
  const scenarios = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url), 'utf8'));
  const scenario = scenarios.find((s: { name: string }) => s.name === name);
  const expected = JSON.parse(readFileSync(new URL(`../fixtures/expected/${name}.json`, import.meta.url), 'utf8'));
  const records = expected.imported.records;
  const base = fresh(0);
  const map = { FGM: 'fgm', FGA: 'fga', FTM: 'ftm', FTA: 'fta', '3PM': 'three', PTS: 'pts', REB: 'reb', AST: 'ast', STL: 'stl', BLK: 'blk', TO: 'to' };
  const w: WorkspaceSnapshot = { ...base, league: { ...base.league, userTeamId: `t${scenario.myTeam}` }, datasets: [{ ...base.datasets[0], unit: scenario.mode }],
    players: records.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })),
    projections: records.map((p: { id: string; rank: number | null; valid: boolean; values: Record<string, number> }) => ({ playerId: p.id, datasetId: 'data', ...(p.rank === null ? {} : { rank: p.rank }), ...(p.valid ? { status: 'valid', gamesPlayed: p.values.gp, stats: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, p.values[v]])) } : { status: 'excluded', reasons: ['fixed invalid'] }) })),
    eligibility: records.map((p: { id: string; pos: string }) => ({ playerId: p.id, season: 'fixture', scope: { kind: 'dataset', datasetId: 'data' }, positions: p.pos.toUpperCase().split(/[^A-Z]+/).filter(Boolean) })),
    strategies: base.strategies.map(s => s.teamId === `t${scenario.myTeam}` ? { ...s, targets: scenario.targets } : s),
    draftSession: { ...base.draftSession!, picks: expected.picks.map((p: { id: string; team: number }, selectionIndex: number) => ({ playerId: p.id, teamId: `t${p.team}`, selectionIndex, outOfTurnConfirmed: true })), status: expected.picks.length === 130 ? 'completed' : expected.picks.length ? 'inProgress' : 'setup' } };
  assert.deepEqual(validateWorkspace(w), []);
  const actual = selectDraftWorkspace(freeze(w)).topFive;
  assert.deepEqual(actual.map(p => p.playerId), expected.suggestions.map((p: { p: string }) => p.p));
  actual.forEach((p, i) => assert.ok(Math.abs(p.score - expected.suggestions[i].score) <= 1e-9 * Math.max(1, Math.abs(p.score))));
});
