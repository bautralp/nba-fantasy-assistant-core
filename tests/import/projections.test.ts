import { createWorkbook } from '../helpers/legacyWorkbook.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { readWorkbook, exportPlayerPool } from '../../src/infrastructure/projections/workbook.ts';
import { readCsv, readProjectionJson } from '../../src/infrastructure/projections/textReaders.ts';
import { HEADERS, normalizeFile, numberCell, type RawFile } from '../../src/application/projectionRows.ts';
import { prepareImport, inspectImport, applyImport } from '../../src/application/importPlayers.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';
import { snakeTeamAt } from '../../src/domain/rules/draftRules.ts';
import { validateWorkspace } from '../../src/domain/rules/invariants.ts';
import { projectTotals } from '../../src/engine/projections.ts';
import { WorkspaceStore } from '../../src/application/workspaceStore.ts';
import { exportWorkspaceJson, restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { LocalStorageWorkspaceRepository } from '../../src/infrastructure/persistence/localStorageWorkspaceRepository.ts';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';

const season = '2026-27', now = '2026-10-20T12:00:00Z';
let sequence = 0; const id = () => `uuid-${sequence++}`;
const fresh = () => createInitialWorkspace({ leagueId: 'league', season, teamIds: Array.from({ length: 10 }, (_, i) => `team-${i}`), draftSessionId: 'draft' });
const row = (name = 'Synthetic Alpha', playerId = ''): unknown[] => [playerId, name, 'G', 1, 60.5, 0, 0, 0, 0, 0, 10, 2, 3, 1, 1, 2];
const raw = (rows: unknown[][] = [row()]): RawFile => ({ name: 'synthetic.csv', format: 'csv', headers: [...HEADERS], rows, season, unit: 'perGame', schemaVersion: 1 });
function preview(file = raw(), workspace = fresh(), revision = 0) { return prepareImport(normalizeFile(file), workspace, revision, id, now); }
function load(file = raw(), workspace = fresh()) { const p = preview(file, workspace); return applyImport(p, {}, workspace, 0); }
function editWorkbook(bytes: Uint8Array, edit: (parts: Record<string, Uint8Array>) => void) { const parts = unzipSync(bytes); edit(parts); return zipSync(parts); }

test('real three-sheet XLSX template contains headers and no player rows and can be read again', () => {
  const bytes = createWorkbook(season, 'perGame'); assert.deepEqual([...bytes.slice(0, 2)], [80, 75]);
  const files = unzipSync(bytes); assert.equal(Object.keys(files).filter(k => k.startsWith('xl/worksheets/')).length, 3);
  const parsed = readWorkbook(bytes, 'nba-fantasy-projections.xlsx'); assert.deepEqual(parsed.headers, HEADERS.filter(h => h !== 'PLAYER_ID')); assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.season, season); assert.equal(parsed.unit, 'perGame'); assert.equal(parsed.schemaVersion, 1);
  assert.throws(() => normalizeFile(parsed), /kimliği/);
});
test('XLSX, legacy-compatible CSV aliases and JSON have identical normalized domain projections', () => {
  const rows = [row('Synthetic A & B <C>')];
  const xlsx = readWorkbook(createWorkbook(season, 'perGame', rows), 'file.xlsx');
  const csv = readCsv([HEADERS.join(';'), rows[0].join(';')].join('\r\n'), 'file.csv');
  const json = readProjectionJson(JSON.stringify({ schemaVersion: 1, season, unit: 'perGame', players: rows.map(r => Object.fromEntries(HEADERS.map((h, i) => [h, r[i]]))) }), 'file.json');
  const normalized = [xlsx, csv, json].map(f => normalizeFile(f, f === csv ? { season, unit: 'perGame' } : {}));
  assert.deepEqual(normalized[0].rows, normalized[1].rows); assert.deepEqual(normalized[1].rows, normalized[2].rows);
  const outputs = normalized.map(file => { let i = 0; const w = fresh(), p = prepareImport(file, w, 0, () => `same-${i++}`, now); return applyImport(p, {}, w, 0); });
  for (const output of outputs) { assert.deepEqual(output.players, outputs[0].players); assert.deepEqual(output.projections, outputs[0].projections); assert.deepEqual(output.eligibility, outputs[0].eligibility); }
  const alias = raw(); alias.headers = alias.headers.map(h => ({ PLAYER: 'Player Name', GP: 'Games Played', '3PM': 'threePointersMade', TO: 'TOV' })[h] ?? h);
  assert.deepEqual(normalizeFile(alias).rows, normalizeFile(raw()).rows);
});
test('decimal GP, zero shot volume and G/F eligibility stay valid without position expansion', () => {
  for (const pos of ['G', 'F', 'PG/SG', '']) {
    const cells = row(); cells[2] = pos; const w = load(raw([cells])); const p = w.projections[0]; assert.equal(p.status, 'valid');
    assert.deepEqual(w.eligibility[0].positions, pos ? pos.split('/') : []);
    assert.equal(projectTotals(p, w.datasets[0])!.gamesPlayed, 60.5);
    assert.equal(projectTotals(p, w.datasets[0])!.stats.FGM, 0);
  }
});
test('empty, negative, non-finite, ambiguous and formula stats exclude; numeric zero never does', () => {
  for (const value of ['', null, undefined, -1, Infinity, NaN, '1,234', '1 234', '1.234,5', '=1+1', { formula: true }, true]) {
    const cells = row(); cells[5] = value; const w = load(raw([cells])); assert.equal(w.projections[0].status, 'excluded'); assert.equal(projectTotals(w.projections[0], w.datasets[0]), null);
  }
  for (const value of [0, '0', '0.0']) assert.equal(numberCell(value), 0);
});
test('GP and makes/attempts are errors; optional invalid rank/POS are only warnings', () => {
  for (const [index, value] of [[4, 0], [5, 1], [7, 1]] as const) { const cells = row(); cells[index] = value; assert.equal(load(raw([cells])).projections[0].status, 'excluded'); }
  const cells = row(); cells[2] = 'G,UNKNOWN'; cells[3] = 1.5;
  const file = normalizeFile(raw([cells])); assert.equal(file.rows[0].issues.length, 2); assert.ok(file.rows[0].issues.every(i => i.level === 'warning'));
  const w = load(raw([cells])); assert.equal(w.projections[0].status, 'valid'); assert.equal(w.projections[0].rank, undefined);
});
test('file-level rejection: required columns, aliases, schema, season, mixed units and backups', () => {
  assert.throws(() => normalizeFile({ ...raw(), headers: HEADERS.filter(h => h !== 'PTS') }), /Eksik/);
  assert.throws(() => normalizeFile({ ...raw(), headers: [...HEADERS, 'Player Name'] }), /çelişkili/);
  assert.throws(() => normalizeFile({ ...raw(), schemaVersion: 2 }), /şema/);
  assert.throws(() => normalizeFile({ ...raw(), unit: 'season' }), /birimi/);
  assert.throws(() => normalizeFile({ ...raw(), unit: undefined }), /açıkça/);
  assert.throws(() => normalizeFile({ ...raw(), season: undefined }), /açıkça/);
  assert.throws(() => normalizeFile({ ...raw(), headers: [...HEADERS, 'mode'], rows: [[...row(), 'totals']] }), /birimi/);
  assert.throws(() => normalizeFile(raw(), { unit: 'totals' }), /uyuşmuyor/);
  assert.throws(() => preview({ ...raw(), season: '2025-26' }), /sezon/);
  for (const backup of [fresh(), { players: [], teams: [], picks: [] }]) assert.throws(() => readProjectionJson(JSON.stringify(backup), 'backup.json'), /yedek/);
  assert.throws(() => readCsv('PLAYER;GP\n"unclosed', 'bad.csv'), /tırnak/);
  assert.throws(() => readProjectionJson('{', 'bad.json'), /Bozuk/);
});
test('XLSX rejects corrupt archives, missing sheets/settings, duplicate headers and unsupported schema', () => {
  assert.throws(() => readWorkbook(strToU8('broken'), 'bad.xlsx'), /Bozuk/);
  const good = createWorkbook(season, 'perGame', [row()]);
  const missing = editWorkbook(good, p => { p['xl/workbook.xml'] = strToU8(strFromU8(p['xl/workbook.xml']).replace(/<sheet name="Settings"[^>]+\/>/, '')); });
  assert.throws(() => readWorkbook(missing, 'bad.xlsx'), /Settings/);
  const schema = editWorkbook(good, p => { p['xl/worksheets/sheet2.xml'] = strToU8(strFromU8(p['xl/worksheets/sheet2.xml']).replace('<v>1</v>', '<v>2</v>')); });
  assert.throws(() => normalizeFile(readWorkbook(schema, 'bad.xlsx')), /şema/);
  const duplicate = editWorkbook(good, p => { p['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(p['xl/worksheets/sheet1.xml']).replace('<t xml:space="preserve">PTS</t>', '<t xml:space="preserve">FGA</t>')); });
  assert.throws(() => normalizeFile(readWorkbook(duplicate, 'bad.xlsx')), /çelişkili/);
});
test('XLSX cached formulas never enter analysis even when cached numeric result is valid', () => {
  const bytes = editWorkbook(createWorkbook(season, 'perGame', [row()]), p => { p['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(p['xl/worksheets/sheet1.xml']).replace('<c r="F2"><v>0</v></c>', '<c r="F2"><f>0+0</f><v>0</v></c>')); });
  const w = load(readWorkbook(bytes, 'formula.xlsx')); assert.equal(w.projections[0].status, 'excluded');
});
test('new IDs are stable throughout preview decisions and same-name rows remain separate', () => {
  const w = fresh(), p = preview(raw([row('Same name'), row('Same name')]), w);
  const first = inspectImport(p, {}); assert.deepEqual(inspectImport(p, {}), first); assert.notEqual(first.resolved[0].playerId, first.resolved[1].playerId);
  const applied = applyImport(p, {}, w, 0); assert.equal(applied.players.length, 2); assert.equal(applied.players[0].id, p.rows[0].newId);
  const next = preview(raw([row('Same name')]), applied); assert.equal(inspectImport(next, {}).errors.length, 1);
  assert.throws(() => applyImport(next, {}, applied, 0), /kararı/);
});
test('duplicate, conflicting, legacy provider and multiply matched IDs require explicit decisions', () => {
  const w0 = load(); const original = w0.players[0];
  const w = { ...w0, players: [...w0.players, { id: 'another', name: 'Other', providerIds: { legacyV3: original.id } }] };
  for (const rows of [[row('Synthetic Alpha', original.id)], [row('Renamed', original.id)], [row('Synthetic Alpha', 'x'), row('Other', 'x')]]) {
    const p = preview(raw(rows), w); assert.ok(p.rows.some(r => r.problem)); assert.throws(() => applyImport(p, {}, w, 0), /kararı/);
  }
  const legacy = { ...w0, players: [{ ...original, providerIds: { legacyV3: 'old-id' } }] };
  const p = preview(raw([row('Different name', 'old-id')]), legacy); assert.ok(p.rows[0].problem);
  const applied = applyImport(p, { 2: { kind: 'match', playerId: original.id } }, legacy, 0); assert.equal(applied.players.length, 1);
});
test('one player cannot receive two rows; explicit skip and explicit new resolve duplicate IDs', () => {
  const w = load(); const playerId = w.players[0].id; const p = preview(raw([row('Synthetic Alpha', playerId), row('Synthetic Alpha', playerId)]), w);
  assert.throws(() => applyImport(p, { 2: { kind: 'match', playerId }, 3: { kind: 'match', playerId } }, w, 0), /birden/);
  const applied = applyImport(p, { 2: { kind: 'match', playerId }, 3: { kind: 'skip' } }, w, 0); assert.equal(applied.projections.filter(r => r.datasetId === p.datasetId).length, 1);
  assert.equal(applyImport(p, { 2: { kind: 'match', playerId }, 3: { kind: 'new' } }, w, 0).players.length, 2);
});
test('ID-bearing Excel export and reimport preserve identity and stats across reloads', () => {
  const w = load(); const file = readWorkbook(exportPlayerPool(w), 'export.xlsx'); assert.equal(file.rows[0][0], w.players[0].id);
  file.rows[0][10] = 20;
  const next = load(file, w); assert.equal(next.players.length, 1); assert.equal(next.projections.at(-1)!.playerId, w.players[0].id);
  assert.deepEqual(next.projections[0], w.projections[0]); assert.equal(next.datasets.length, 2);
});
function drafted(count: number): WorkspaceSnapshot {
  const initial = load(raw(Array.from({ length: 131 }, (_, i) => row(`Synthetic ${i}`))));
  const session = initial.draftSession!;
  const picks = initial.players.slice(0, count).map((p, i) => ({ playerId: p.id, teamId: snakeTeamAt(session.draftOrder, i, initial.league.rules)!, selectionIndex: i, outOfTurnConfirmed: i === 0 }));
  // Explicitly confirmed out-of-turn ownership, with valid per-team capacity.
  if (count > 1 && count < 130) [picks[0].teamId, picks[1].teamId] = [picks[1].teamId, picks[0].teamId];
  if (count > 1 && count < 130) picks[1].outOfTurnConfirmed = true;
  return { ...initial, league: { ...initial.league, userTeamId: initial.teams[2].id }, draftSession: { ...session, picks, status: count === 130 ? 'completed' : 'inProgress' } };
}
for (const count of [1, 65, 129, 130]) test(`reload at ${count} picks preserves entire draft, ownership, chronology, flags and strategies`, () => {
  const w = drafted(count); assert.deepEqual(validateWorkspace(w), []); const before = JSON.stringify(w);
  const cells = row(w.players[0].name, w.players[0].id); cells[5] = '';
  const p = preview(raw([cells, row('New synthetic')]), w); const review = inspectImport(p, {});
  assert.equal(review.missingPicked.length, count - 1); assert.ok(review.removed.length > 0);
  const next = applyImport(p, { 3: { kind: 'new' } }, w, 0);
  assert.equal(next.draftSession, w.draftSession); assert.equal(next.strategies, w.strategies); assert.equal(next.league.userTeamId, w.league.userTeamId);
  assert.deepEqual(next.draftSession!.picks, w.draftSession!.picks); assert.equal(JSON.stringify(w), before);
  assert.equal(next.projections.find(r => r.datasetId === next.league.activeDatasetId && r.playerId === cells[0])!.status, 'excluded');
  if (count > 1) assert.equal(next.projections.find(r => r.datasetId === next.league.activeDatasetId && r.playerId === w.players[1].id), undefined);
  assert.equal(projectTotals(w.projections[0], next.datasets.at(-1)!), null);
});
test('all excluded stays excluded and no valid player is fabricated', () => {
  const cells = row(); cells[4] = ''; const w = fresh(), p = preview(raw([cells]), w); assert.equal(inspectImport(p, {}).valid, 0);
  const next = applyImport(p, {}, w, 0); assert.equal(next.projections[0].status, 'excluded'); assert.equal(projectTotals(next.projections[0], next.datasets[0]), null);
});
test('file rejection, cancellation and unresolved identity leave workspace unchanged; stale revisions block apply', () => {
  const w = load(); const before = JSON.stringify(w); const p = preview(raw(), w, 2);
  assert.throws(() => applyImport(p, { 2: { kind: 'new' } }, w, 3), /yeniden/);
  assert.throws(() => applyImport(p, { 2: { kind: 'new' } }, { ...w }, 2), /yeniden/);
  assert.throws(() => applyImport(p, {}, w, 2), /kararı/); assert.equal(JSON.stringify(w), before);
});
test('failed browser persistence retains imported dataset in memory and JSON recovery; successful save/reload keeps history', async () => {
  const w = drafted(2); const next = load(raw([row(w.players[0].name, w.players[0].id)]), w);
  let record: string | null = null;
  const repository = new LocalStorageWorkspaceRepository(() => ({ getItem: () => record, setItem: (_key, value) => { record = value; } }));
  const store = new WorkspaceStore(repository); await store.load(); assert.ok(store.accept(next)); await store.save(); assert.equal(store.getSnapshot().dirty, false);
  const reopened = await repository.load(); assert.ok(reopened.ok); assert.deepEqual(reopened.value, next);
  const failed = new WorkspaceStore(new LocalStorageWorkspaceRepository(() => ({ getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } })));
  await failed.load(); assert.ok(failed.accept(next)); await failed.save(); assert.ok(failed.getSnapshot().dirty); assert.equal(failed.getSnapshot().workspace, next);
  const json = exportWorkspaceJson(failed.getSnapshot().workspace!); assert.ok(json.ok); const restored = restoreWorkspaceJson(json.value); assert.ok(restored.ok); assert.deepEqual(restored.value, next);
});

test('independent openpyxl workbook preserves Unicode/XML text, absolute relationships, sparse cells and formulas', async () => {
  const { readFile } = await import('node:fs/promises');
  const file = readWorkbook(new Uint8Array(await readFile(new URL('../fixtures/import/openpyxl.xlsx', import.meta.url))), 'independent.xlsx');
  assert.equal(file.rows[0][1], 'Synthetic Çığ & <Alpha>');
  const next = load(file); assert.equal(next.projections[0].status, 'valid'); assert.equal(next.projections[1].status, 'excluded');
});
test('XLSX shared strings and sparse cells use the same validator; malformed/DTD and size limits reject', () => {
  const bytes = createWorkbook(season, 'perGame', [row()]);
  const shared = editWorkbook(bytes, parts => {
    parts['xl/sharedStrings.xml'] = strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Synthetic Shared</t></si></sst>');
    parts['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(parts['xl/worksheets/sheet1.xml']).replace('<c r="B2" t="inlineStr"><is><t xml:space="preserve">Synthetic Alpha</t></is></c>', '<c r="B2" t="s"><v>0</v></c>'));
  });
  assert.equal(readWorkbook(shared, 'shared.xlsx').rows[0][1], 'Synthetic Shared');
  const dtd = editWorkbook(bytes, parts => { parts['xl/workbook.xml'] = strToU8('<!DOCTYPE workbook [<!ENTITY boom "x">]><workbook/>'); });
  assert.throws(() => readWorkbook(dtd, 'dtd.xlsx'), /XML/);
  assert.throws(() => readWorkbook(new Uint8Array(21 * 1024 * 1024), 'large.xlsx'), /20 MB/);
});

test('unique supplied IDs establish permanent identities; reordered same-name players match only by ID', () => {
  const w = load(raw([row('Same name', 'supplied-a'), row('Same name', 'supplied-b')]));
  assert.deepEqual(w.players.map(p => p.id), ['supplied-a', 'supplied-b']);
  const next = load(raw([row('Same name', 'supplied-b'), row('Same name', 'supplied-a')]), w);
  assert.deepEqual(next.players, w.players);
  assert.deepEqual(next.projections.filter(p => p.datasetId === next.league.activeDatasetId).map(p => p.playerId), ['supplied-b', 'supplied-a']);
});

test('JSON duplicate keys including escaped equivalents are rejected before identity can be overwritten', () => {
  assert.throws(() => readProjectionJson('[{"PLAYER_ID":"one","PLAYER_ID":"two"}]', 'duplicate.json'), /mükerrer/);
  assert.throws(() => readProjectionJson('[{"PLAYER":"one","\\u0050LAYER":"two"}]', 'duplicate.json'), /mükerrer/);
});

test('ID-less reload needs explicit identity decision even with a completely different name', () => {
  const w = load(), p = preview(raw([row('Completely different synthetic name')]), w);
  assert.throws(() => applyImport(p, {}, w, 0), /kararı/);
  const next = applyImport(p, { 2: { kind: 'new' } }, w, 0); assert.equal(next.players.length, 2);
});
