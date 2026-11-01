import { createWorkbook } from '../helpers/legacyWorkbook.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { HEADERS, normalizeFile, playerIdCell, type RawFile } from '../../src/application/projectionRows.ts';
import { applyImport, inspectImport, prepareImport, type IdentityDecision } from '../../src/application/importPlayers.ts';
import { readWorkbook, exportPlayerPool } from '../../src/infrastructure/projections/workbook.ts';
import { readCsv, readProjectionJson } from '../../src/infrastructure/projections/textReaders.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';
import { validateWorkspace } from '../../src/domain/rules/invariants.ts';

const season = '2026-27', importedAt = '2026-10-20T12:00:00Z';
const fresh = () => createInitialWorkspace({ leagueId: 'identity', season, teamIds: Array.from({ length: 10 }, (_, i) => `team-${i}`), draftSessionId: 'identity-draft' });
const cells = (id: unknown, name = 'Synthetic Identity') => [id, name, 'G', 1, 60.5, 0, 0, 0, 0, 0, 20, 4, 3, 1, 1, 2];
const jsonFile = (rows: unknown[][]) => readProjectionJson(JSON.stringify({ season, unit: 'perGame', players: rows.map(r => Object.fromEntries(HEADERS.map((key, i) => [key, r[i]]))) }), 'identities.json');
const csvFile = (rows: unknown[][]) => readCsv([HEADERS, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n'), 'identities.csv');
const readers = (rows: unknown[][]) => [readWorkbook(createWorkbook(season, 'perGame', rows), 'identities.xlsx'), csvFile(rows), jsonFile(rows)];
const normalize = (raw: RawFile) => normalizeFile(raw, { season, unit: 'perGame' });
let sequence = 0;
const id = () => `generated-${sequence++}`;

test('PLAYER_ID accepts safe positive integers and opaque text, distinguishing empty from invalid identity', () => {
  for (const value of [undefined, null, '']) assert.deepEqual(playerIdCell(value), { value: '' });
  for (const value of ['00123', ' 00123 ', '9007199254740993', '1e30']) assert.deepEqual(playerIdCell(value), { value });
  for (const value of [1, 2, 3, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) assert.deepEqual(playerIdCell(value), { value: String(value) });
  for (const value of [0, Number.MAX_SAFE_INTEGER + 1, 1.5, -1, Infinity, NaN, false, {}, '   ']) {
    assert.equal(playerIdCell(value).value, ''); assert.match(playerIdCell(value).error!, /PLAYER_ID metin/);
  }
});
test('XLSX CSV and JSON preserve exact text IDs across MAX_SAFE_INTEGER without collision or trimming', () => {
  const ids = ['9007199254740990', '9007199254740991', '9007199254740992', '9007199254740993', '00123', ' 00123 ', '123'];
  for (const file of readers(ids.map(value => cells(value)))) {
    const w = fresh(), normalized = normalize(file);
    assert.deepEqual(normalized.rows.map(r => r.externalId), ids);
    assert.ok(normalized.rows.every(r => !r.identityError));
    const p = prepareImport(normalized, w, 0, id, importedAt), next = applyImport(p, {}, w, 0);
    assert.deepEqual(next.players.map(player => player.id), ids); assert.equal(new Set(next.players.map(player => player.id)).size, ids.length);
    const exported = normalize(readWorkbook(exportPlayerPool(next), 'roundtrip.xlsx'));
    assert.deepEqual(exported.rows.map(r => r.externalId), ids);
    const again = prepareImport(exported, next, 1, id, importedAt);
    assert.deepEqual(again.rows.map(r => r.automaticId), ids);
    assert.deepEqual(applyImport(again, {}, next, 1).players, next.players);
  }
  const shared = unzipSync(createWorkbook(season, 'perGame', [cells(' 00123 ')]));
  shared['xl/sharedStrings.xml'] = strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t xml:space="preserve"> 00123 </t></si></sst>');
  shared['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(shared['xl/worksheets/sheet1.xml']).replace('<c r="A2" t="inlineStr"><is><t xml:space="preserve"> 00123 </t></is></c>', '<c r="A2" t="s"><v>0</v></c>'));
  assert.equal(normalize(readWorkbook(zipSync(shared), 'shared-id.xlsx')).rows[0].externalId, ' 00123 ');
});
test('unsafe numeric Excel and JSON IDs are blocking row identity errors', () => {
  const values = [0, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2, 1.5];
  for (const file of [readWorkbook(createWorkbook(season, 'perGame', values.map(value => cells(value))), 'numbers.xlsx'), jsonFile(values.map(value => cells(value)))]) {
    const normalized = normalize(file), w = fresh(); let allocations = 0;
    const p = prepareImport(normalized, w, 0, () => `id-${allocations++}`, importedAt);
    assert.equal(allocations, 1, 'only dataset ID is allocated; invalid identity never receives a UUID');
    normalized.rows.forEach((r, i) => {
      assert.equal(r.externalId, ''); assert.ok(r.identityError);
      assert.ok(r.issues.some(issue => issue.level === 'identity' && issue.field === 'PLAYER_ID' && issue.row === i + 2));
      assert.equal(p.rows[i].automaticId, undefined); assert.equal(p.rows[i].newId, '');
      assert.ok(inspectImport(p, {}).errors.some(error => error.includes(`Satır ${i + 2}`) && error.includes('PLAYER_ID')));
    });
    assert.throws(() => applyImport(p, {}, w, 0), /Satır 2 · PLAYER_ID/);
  }
});
test('invalid numeric identity with no player name is retained as an identity error instead of silently dropped', () => {
  const normalized = normalize(jsonFile([cells(Number.MAX_SAFE_INTEGER + 1, '')]));
  assert.equal(normalized.rows.length, 1); assert.ok(normalized.rows[0].identityError);
  const w = fresh(), p = prepareImport(normalized, w, 0, id, importedAt);
  assert.throws(() => applyImport(p, { 2: { kind: 'new' } }, w, 0), /PLAYER_ID/);
});

function lossyFiles(): RawFile[] {
  const parts = unzipSync(createWorkbook(season, 'perGame', [cells(0), cells(0), cells('unrelated-player', 'Synthetic Unrelated')]));
  parts['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(parts['xl/worksheets/sheet1.xml'])
    .replace('<c r="A2"><v>0</v></c>', '<c r="A2"><v>9007199254740992</v></c>')
    .replace('<c r="A3"><v>0</v></c>', '<c r="A3"><v>9007199254740993</v></c>'));
  const json = JSON.stringify({ season, unit: 'perGame', players: [cells('FIRST'), cells('SECOND'), cells('unrelated-player', 'Synthetic Unrelated')].map(r => Object.fromEntries(HEADERS.map((key, i) => [key, r[i]]))) })
    .replace('"FIRST"', '9007199254740992').replace('"SECOND"', '9007199254740993');
  return [readWorkbook(zipSync(parts), 'lossy.xlsx'), readProjectionJson(json, 'lossy.json')];
}
test('two distinct numeric source IDs that round to the same number never match a drafted player', () => {
  const initial = fresh(), playerId = '9007199254740992';
  const w = { ...initial, players: [{ id: playerId, name: 'Synthetic Identity' }],
    league: { ...initial.league, userTeamId: initial.teams[0].id },
    draftSession: { ...initial.draftSession!, status: 'inProgress' as const, picks: [{ playerId, teamId: initial.teams[0].id, selectionIndex: 0, outOfTurnConfirmed: false }] } };
  assert.deepEqual(validateWorkspace(w), []); const before = JSON.stringify(w);
  for (const file of lossyFiles()) {
    assert.equal(file.rows[0][0], file.rows[1][0], 'adversarial source values have already collided in IEEE-754');
    const p = prepareImport(normalize(file), w, 0, id, importedAt);
    assert.ok(p.rows.slice(0, 2).every(r => r.problem && !r.automaticId && !r.newId));
    for (const decision of [{ kind: 'new' }, { kind: 'match', playerId }] as IdentityDecision[]) {
      assert.throws(() => applyImport(p, { 2: decision, 3: { kind: 'skip' } }, w, 0), /Satır 2 · PLAYER_ID/);
    }
    assert.equal(JSON.stringify(w), before);
    const next = applyImport(p, { 2: { kind: 'skip' }, 3: { kind: 'skip' } }, w, 0);
    assert.equal(next.draftSession, w.draftSession); assert.equal(next.strategies, w.strategies); assert.equal(next.league.userTeamId, w.league.userTeamId);
    assert.equal(next.players.find(player => player.id === playerId), w.players[0]);
    assert.ok(!next.projections.some(projection => projection.playerId === playerId));
    assert.deepEqual(validateWorkspace(next), []);
  }
});
test('CSV decimal IDs and quoted JSON/Excel IDs remain distinct even when their numeric equivalents collide', () => {
  for (const file of readers([cells('9007199254740992'), cells('9007199254740993')])) {
    const w = fresh(), p = prepareImport(normalize(file), w, 0, id, importedAt);
    assert.deepEqual(inspectImport(p, {}).errors, []);
    assert.deepEqual(applyImport(p, {}, w, 0).players.map(player => player.id), ['9007199254740992', '9007199254740993']);
  }
});

test('Excel numeric PLAYER_ID 1, 2, 3 and text equivalents reimport without changing identities', () => {
  const w = fresh(), numeric = normalize(readWorkbook(createWorkbook(season,'perGame',[cells(1,'One'),cells(2,'Two'),cells(3,'Three')]),'numeric.xlsx'));
  const next = applyImport(prepareImport(numeric,w,0,id,importedAt),{},w,0);
  assert.deepEqual(next.players.map(p=>p.id),['1','2','3']);
  const again = prepareImport(normalize(jsonFile([cells('1','One'),cells('2','Two'),cells('3','Three')])),next,1,id,importedAt);
  assert.deepEqual(again.rows.map(r=>r.automaticId),['1','2','3']);
  assert.deepEqual(applyImport(again,{},next,1).players,next.players);
});
test('same numeric ID with Nikola Jokic / Jokic preserves visible name, history, ownership and old datasets', () => {
  const w = fresh(), next = applyImport(prepareImport(normalize(jsonFile([cells(1,'Nikola Jokic')])),w,0,id,importedAt),{},w,0);
  const picked = {...next,league:{...next.league,userTeamId:next.teams[0].id},draftSession:{...next.draftSession!,status:'inProgress' as const,picks:[{playerId:'1',teamId:next.teams[0].id,selectionIndex:0}]}};
  const preview = prepareImport(normalize(jsonFile([cells('1','Jokic')])),picked,1,id,importedAt);
  assert.equal(preview.rows[0].automaticId,'1'); assert.equal(preview.rows[0].problem,undefined);
  const reloaded = applyImport(preview,{},picked,1);
  assert.equal(reloaded.players[0].name,'Nikola Jokic'); assert.equal(reloaded.draftSession,picked.draftSession);
  assert.deepEqual(reloaded.datasets.slice(0,-1),picked.datasets); assert.deepEqual(reloaded.projections.slice(0,-1),picked.projections);
});
test('projectionFile provider IDs resolve renamed rows to existing UUID while exports keep that UUID stable', () => {
  const uuid = 'fd2fd25d-fb27-4896-bc2b-36929b6ea71c';
  const w = {...fresh(),players:[{id:uuid,name:'Nikola Jokic',providerIds:{projectionFile:'1'}}]};
  const p = prepareImport(normalize(jsonFile([cells(1,'Jokic')])),w,0,id,importedAt);
  assert.equal(p.rows[0].automaticId,uuid);
  const next = applyImport(p,{},w,0); assert.equal(next.players.length,1); assert.equal(next.projections[0].playerId,uuid);
  for(let i=0;i<2;i++) assert.equal(readWorkbook(exportPlayerPool(next),'pool.xlsx').rows[0][0],uuid);
});
test('different numeric IDs with identical or similar names never merge automatically', () => {
  const w = fresh(), next = applyImport(prepareImport(normalize(jsonFile([cells(1,'Nikola Jokic')])),w,0,id,importedAt),{},w,0);
  for(const name of ['Nikola Jokic','Jokic']) {
    const p = prepareImport(normalize(jsonFile([cells(2,name)])),next,1,id,importedAt); assert.equal(p.rows[0].automaticId,undefined);
    const result = applyImport(p,p.rows[0].problem ? {2:{kind:'new'}} : {},next,1);
    assert.equal(result.players.length,2); assert.notEqual(result.projections.at(-1)!.playerId,'1');
  }
});
test('numeric/text duplicate IDs require decisions and leading zero IDs remain deterministically distinct', () => {
  const w = fresh(), p = prepareImport(normalize(jsonFile([cells(1,'One'),cells('1','Other')])),w,0,id,importedAt);
  assert.ok(p.rows.every(r=>r.problem?.includes('Mükerrer'))); assert.throws(()=>applyImport(p,{},w,0),/kararı/);
  const zeros = prepareImport(normalize(jsonFile([cells(1,'One'),cells('001','One')])),w,0,id,importedAt);
  assert.deepEqual(applyImport(zeros,{},w,0).players.map(p=>p.id),['1','001']);
});
test('safe numeric boundary succeeds and arbitrary length text IDs keep every digit', () => {
  assert.equal(playerIdCell(Number.MAX_SAFE_INTEGER).value,'9007199254740991');
  assert.ok(playerIdCell(Number.MAX_SAFE_INTEGER + 1).error);
  const huge = '1234567890123456789012345678901234567890';
  for(const file of readers([cells(huge)])) assert.equal(normalize(file).rows[0].externalId,huge);
});

test('source numeric fractions that round into safe integers never establish identities in Excel or JSON', () => {
  for(const source of ['9007199254740991.1','1.00000000000000001','9.0071992547409911e15']) {
    const parts = unzipSync(createWorkbook(season,'perGame',[cells(1)]));
    parts['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(parts['xl/worksheets/sheet1.xml']).replace('<c r="A2"><v>1</v></c>',`<c r="A2"><v>${source}</v></c>`));
    const json = JSON.stringify({season,unit:'perGame',players:[Object.fromEntries(HEADERS.map((k,i)=>[k,cells('RAW')[i]]))]}).replace('"RAW"',source);
    for(const raw of [readWorkbook(zipSync(parts),'fraction.xlsx'),readProjectionJson(json,'fraction.json')]) assert.ok(normalize(raw).rows[0].identityError);
  }
});
