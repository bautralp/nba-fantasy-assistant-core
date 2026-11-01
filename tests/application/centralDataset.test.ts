import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCentralDataset } from '../../src/application/centralDataset.ts';
import { parseProjections, parseEligibility, rankProjections } from '../../src/features/rankings/rosProjection.ts';
import { projectTotals } from '../../src/engine/projections.ts';
import { fresh } from '../helpers/draftFixture.ts';
import { restoreWorkspaceJson, exportWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { WorkspaceStore } from '../../src/application/workspaceStore.ts';
const read = (path: string) => JSON.parse(readFileSync(new URL('../../public/data/' + path, import.meta.url), 'utf8'));
const ros = read('player-projections.json'), actual = read('player-stats.json');
const id = () => { let i = 0; return () => `test-uuid-${++i}`; };
const base = () => { const w = fresh(0); return { ...w, league: { ...w.league, season: '2026-27', activeDatasetId: null }, datasets: [] }; };
const now = '2026-10-22T00:00:00Z';

test('real ROS snapshot validates and shared per-game Z ignores ROS GP', () => {
  const snapshot = parseProjections(ros);
  const changed = structuredClone(snapshot);
  changed.players.forEach(p => { if (p.rosGP !== null) p.rosGP /= 2; });
  assert.deepEqual(rankProjections(changed).players.map(p => p.totalZ), snapshot.players.map(p => p.totalZ));
  const player = snapshot.players.find(p => p.name === 'Cade Cunningham');
  assert.equal(player?.id, '4432166');
  assert.equal(snapshot.players.find(p => p.name === 'Josh Giddey')?.id, '4871145');
  assert.equal(snapshot.players.find(p => p.name === 'Nikola Jokic')?.id, '3112335');
});
test('general positions, forged ranks, invalid shooting, duplicate IDs and bad source are rejected', () => {
  for (const mutate of [
    (v: typeof ros) => { v.players[0].positions = ['G']; v.players[0].eligibility.positions = ['G']; },
    (v: typeof ros) => { const p = v.players.find((p: {rank: number | null}) => p.rank); p.rank += 1; },
    (v: typeof ros) => { v.players.find((p: {stats: unknown}) => p.stats).stats.FGA = -1; },
    (v: typeof ros) => { v.players.push(v.players[0]); },
    (v: typeof ros) => { v.sources[0].sha256 = 'forged'; },
  ]) { const v = structuredClone(ros); mutate(v); assert.throws(() => parseProjections(v)); }
  assert.throws(() => parseEligibility({ ...ros.players[0].eligibility, positions: ['UTIL'], status: 'verified' }));
  assert.throws(() => parseEligibility({ ...ros.players[0].eligibility, name: 123 }));
});
test('historical actual keeps source season separate and engine multiplies observed GP exactly once', () => {
  const w = applyCentralDataset(base(), 'lastSeason', actual, ros, id(), now);
  const dataset = w.datasets[0]!;
  assert.equal(w.league.season, '2026-27');
  assert.equal(dataset.season, '2026-27');
  assert.equal(dataset.provenance?.sourceSeason, '2025-26');
  assert.equal(dataset.provenance?.gpMeaning, 'observed-last-season');
  const p = w.players.find(p => p.providerIds?.espn === '3112335')!;
  const projection = w.projections.find(r => r.playerId === p.id)!;
  assert.equal(projection.status, 'valid');
  assert.equal(projectTotals(projection, dataset)!.stats.PTS, 1799);
  assert.notEqual(p.id, '3112335');
});
test('projected adapter uses remaining GP, retains unavailable players and never invents positions', () => {
  const w = applyCentralDataset(base(), 'projected', ros, null, id(), now);
  assert.equal(w.players.length, ros.players.length);
  for (const projection of w.projections) {
    const player = w.players.find(p => p.id === projection.playerId)!;
    const source = ros.players.find((p: {id: string}) => p.id === player.providerIds?.espn)!;
    if (projection.status === 'valid') {
      assert.equal(projection.gamesPlayed, source.rosGP);
      assert.equal(projectTotals(projection, w.datasets[0]!)!.stats.PTS, source.stats.PTS * source.rosGP);
    }
  }
  assert.ok(w.projections.some(p => p.status === 'excluded'));
  assert.ok(w.eligibility.every(e => e.positions.every(p => !['G', 'F'].includes(p))));
});
test('UUIDs and source provenance survive strict backup/restore without recalculation', () => {
  const w = applyCentralDataset(base(), 'projected', ros, null, id(), now);
  const exported = exportWorkspaceJson(w); assert.ok(exported.ok);
  const restored = restoreWorkspaceJson(exported.value); assert.ok(restored.ok);
  assert.deepEqual(restored.value, w);
  assert.deepEqual(base().players, []);
});
test('verified ID joins use provider ID only, not names; positions transfer without broad slot expansion', () => {
  const v = structuredClone(ros);
  const p = v.players.find((p: {status: string}) => p.status === 'available');
  const wasVerified = p.positions.length > 0;
  p.positions = ['PG', 'SF']; p.eligibility = { ...p.eligibility, positions: p.positions, status: 'verified', provider: 'Synthetic test catalog', source: 'https://example.test/evidence' };
  if (!wasVerified) { v.positionReport.verified++; v.positionReport.unresolved--; }
  const w = base();
  w.players = [{ id: 'user-uuid', name: p.name, providerIds: { espn: p.id } }];
  const next = applyCentralDataset(w, 'projected', v, null, id(), now);
  assert.equal(next.players.find(x => x.providerIds?.espn === p.id)?.id, 'user-uuid');
  assert.deepEqual(next.eligibility.find(x => x.playerId === 'user-uuid')?.positions, ['PG', 'SF']);
  assert.equal(w.datasets.length, 0);
});
test('locked central pool is isolated from later source mutation and rejected replacement', async () => {
  const w = base();
  const ready = { ...w, strategies: w.strategies.map((s, i) => i ? s : { ...s, targets: { ...s.targets, PTS: 'top3' as const } }) };
  const store = new WorkspaceStore({ load: async () => ({ ok: true, value: ready }), save: async () => ({ ok: true, value: undefined }) }, true);
  await store.load();
  assert.ok(store.accept(applyCentralDataset(ready, 'projected', ros, null, id(), now)));
  await store.save();
  const snapshot = store.getSnapshot().workspace!;
  assert.equal(snapshot.manualDraftLocked, true);
  assert.throws(() => applyCentralDataset(snapshot, 'lastSeason', actual, ros, id(), now));
  assert.equal(store.accept({ ...snapshot, projections: [] }), false);
  const changed = structuredClone(ros); changed.players.length = 0;
  assert.equal(store.getSnapshot().workspace, snapshot);
});

test('rookie metadata is validated and an available rookie enters shared 9CAT and frozen draft pool', () => {
  const v = structuredClone(ros);
  const candidate = structuredClone(v.players.find((p: {status: string}) => p.status === 'available'));
  candidate.id = '999999991'; candidate.name = 'Synthetic rookie integration';
  candidate.eligibility.playerId = candidate.id; candidate.eligibility.name = candidate.name;
  candidate.experience = 'rookie'; candidate.projectionBasis = 'Rookie prior'; candidate.confidence = 'low';
  candidate.verifiedSourceDate = now; candidate.experienceReason = null;
  candidate.rosGP = 50; candidate.teamRemaining = 70;
  v.players.push(candidate);
  v.positionReport[candidate.positions.length ? 'verified' : 'unresolved']++;
  const ranked = rankProjections(v);
  const parsed = parseProjections(ranked);
  const rookie = parsed.players.find(p => p.id === candidate.id)!;
  assert.ok(rookie.rank && Number.isFinite(rookie.totalZ));
  const next = applyCentralDataset(base(), 'projected', ranked, null, id(), now);
  const player = next.players.find(p => p.providerIds?.espn === candidate.id)!;
  assert.notEqual(player.id, candidate.id);
  assert.equal(next.projections.find(p => p.playerId === player.id)?.status, 'valid');
  const before = structuredClone(next);
  candidate.stats.PTS = 999;
  assert.deepEqual(next, before);
  assert.throws(() => applyCentralDataset({ ...next, manualDraftLocked: true }, 'projected', ranked, null, id(), now));
  for (const change of [
    {experience: 'probably-rookie'}, {projectionBasis: 'Unverified NCAA'},
    {verifiedSourceDate: 'not-a-timestamp'}, {experienceReason: 7},
    {draftIdentityVerified: 'yes'}, {nbaEntryVerified: 1},
  ]) {
    const invalid = structuredClone(ranked);
    Object.assign(invalid.players.find(p => p.id === rookie.id)!, change);
    assert.throws(() => parseProjections(invalid));
  }
});

test('newly verified draft identity keeps every current numeric row and locked draft data intact', () => {
  assert.ok(ros.players.length > 0);
  assert.equal(new Set(ros.players.map((p: {id:string}) => p.id)).size, ros.players.length);
  const next = structuredClone(ros);
  const player = next.players.find((p: {id:string}) => p.id === '5142718');
  assert.ok(player);
  Object.assign(player, { draftIdentityVerified: true, nbaEntryVerified: true, experience: 'rookie',
    verifiedSourceDate: '2026-10-23T00:00:00Z' });
  // Identity verification may happen after the statistics cutoff date.
  const parsed = parseProjections(next);
  for (const key of ['stats','shooting','minutes','rosGP','rank','totalZ','role','positions','eligibility','status']) {
    assert.deepEqual(parsed.players.map((p: any) => p[key]), ros.players.map((p: any) => p[key]));
  }
  const original = applyCentralDataset(base(), 'projected', ros, null, id(), now);
  const copy = structuredClone(original);
  assert.throws(() => applyCentralDataset({ ...original, manualDraftLocked: true }, 'projected', next, null, id(), now));
  assert.deepEqual(original, copy);
});

for (const source of ['lastSeason', 'projected'] as const) test(`real ${source} adapter selects usable Draft ranks through pagination, picks and backup`, async () => {
  const { selectDraftWorkspace } = await import('../../src/application/draftSelectors.ts');
  const { applyDraftCommand } = await import('../../src/application/draftCommands.ts');
  const { PAGE_SIZE } = await import('../../src/shared/playerTableModel.ts');
  const w = applyCentralDataset(base(), source, source === 'lastSeason' ? actual : ros, ros, id(), now);
  const view = selectDraftWorkspace(w), r = view.poolRanking;
  const ordered = [...r.ranks].sort((a,b) => a[1]-b[1]);
  assert.ok(ordered.length > PAGE_SIZE * 2);
  assert.match(r.notice, source === 'lastSeason' ? /2025-26 Actual — Last Season.*Kaynak RANK yok.*otomatik/ : /2026-27 Projected — ROS.*yayımlanmış kaynak/);
  if (source === 'lastSeason') {
    assert.equal(r.source, 'automatic');assert.equal(r.issue, 'missing');
    assert.ok(w.projections.every(p => p.rank === undefined));
    assert.deepEqual(ordered.map(([,rank])=>rank),Array.from({length:view.model!.z.size},(_,i)=>i+1));
  } else {
    assert.equal(r.source, 'provided');assert.equal(r.issue, null);
    assert.ok(w.projections.some(p => p.status === 'excluded' && p.rank === undefined));
    for (const p of w.projections.filter(p => p.status === 'valid')) {
      const player = w.players.find(player => player.id === p.playerId)!;
      assert.equal(r.ranks.get(p.playerId), ros.players.find((row:{id:string}) => row.id === player.providerIds?.espn).rank);
    }
    assert.ok(ordered.some(([,rank],i) => i>0 && rank>ordered[i-1][1]+1), 'published gaps are not closed');
  }
  const page = ordered.slice(PAGE_SIZE,PAGE_SIZE*2);
  assert.equal(page.length,50);assert.ok(page[0][1]>ordered[PAGE_SIZE-1][1]);
  for (let i=1;i<ordered.length;i++) if(source==='lastSeason') assert.ok(r.totalZ.get(ordered[i-1][0])!>=r.totalZ.get(ordered[i][0])!);
  const picked = applyDraftCommand(w,{kind:'assign',playerId:ordered[0][0],teamId:w.draftSession!.draftOrder[0]});
  const changed = applyDraftCommand(picked,{kind:'strategy',targets:{...picked.strategies[0].targets,PTS:'punt',REB:'top3'}});
  const exported=exportWorkspaceJson(changed);assert.ok(exported.ok);
  const restored=restoreWorkspaceJson(exported.value);assert.ok(restored.ok);
  const after=selectDraftWorkspace(restored.value);
  assert.deepEqual(after.poolRanking.ranks,r.ranks);assert.deepEqual(after.model,view.model);
  assert.deepEqual([...after.poolRanking.ranks].sort((a,b)=>a[1]-b[1]).slice(PAGE_SIZE,PAGE_SIZE*2),page);
  assert.deepEqual(restored.value,changed);
});
