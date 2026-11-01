import { enterDraft, recovery, settings, importPool, tab } from '../helpers/workspaceUi.mjs';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fresh } from '../helpers/draftFixture.ts';
import { analysisFixture } from '../helpers/analysisFixture.ts';
import { selectDraftWorkspace, draftStatus } from '../../src/application/draftSelectors.ts';
import { selectDraftAnalysis } from '../../src/application/analysisSelectors.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { createWorkbook } from '../../src/infrastructure/projections/workbook.ts';
import { NINE_CATEGORIES } from '../../src/domain/models/categories.ts';
const key = 'nba-fantasy-assistant.session.v1';
let server, browser, base;
before(async () => {
  // Test-only instrumentation verifies memoization without changing production engine files.
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'count-model-calls', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/engine/model.ts')) return code.replace('): CalculationModel {', '): CalculationModel { globalThis.__modelCalls = (globalThis.__modelCalls ?? 0) + 1;');
    },
  }] });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  await mkdir('artifacts/ui', { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
const configured = () => applyDraftCommand(fresh(), { kind: 'strategy', targets: { ...fresh().strategies[0].targets, PTS: 'top3', AST: 'top5' } });
function draft(w, count) { for (let i = 0; i < count; i++) w = applyDraftCommand(w, { kind: 'assign', playerId: `p${i}`, teamId: draftStatus(w).teamId }); return w; }
async function open(t, w = configured(), width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR' }); t.after(() => context.close());
  await context.addInitScript(({ w, key }) => { if (!sessionStorage.seeded) { sessionStorage.setItem(key, JSON.stringify(w)); sessionStorage.seeded = '1'; } }, { w, key });
  const page = await context.newPage(); page.setDefaultTimeout(8000); const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(base); await enterDraft(page); await page.getByRole('heading', { name: 'Oyuncu havuzu', exact: true }).waitFor(); return page;
}
const power = p => p.getByRole('region', { name: 'Category Power Rankings', exact: true, includeHidden: true });
const rosters = p => p.getByRole('region', { name: 'Takım kadroları', exact: true, includeHidden: true });
const detail = p => p.getByRole('region', { name: 'Detaylı kategori ve rakip analizi', exact: true, includeHidden: true });
const dialog = p => p.getByRole('dialog');
const pool = p => p.getByRole('region', { name: 'Oyuncu istatistik tablosu', exact: true });
const team = (p, id) => rosters(p).locator(`.team-roster[data-team-id="${id}"]`);
const player = (p, n) => pool(p).getByRole('button', { name: `Fixture Player ${String(n).padStart(3, '0')}`, exact: true });
async function inspect(p) { await recovery(p); const event = p.waitForEvent('download'); await p.getByRole('button', { name: 'JSON yedeğini indir', exact: true }).click(); return JSON.parse(await readFile(await (await event).path(), 'utf8')); }
async function restore(p, w) { await recovery(p);
  await p.getByLabel('JSON yedeği seç', { exact: true }).setInputFiles({ name: 'analysis.json', buffer: Buffer.from(JSON.stringify(w)) });
  if (w.version === 3) {
    await p.getByLabel('Aktarılan lig adı').fill('Migrated analysis fixture'); await p.getByLabel('Aktarılan sezon').fill('2026-27');
  }
  await p.getByRole('button', { name: 'Yedeği önizle', exact: true }).click();
  if (w.version === 3) {
    await p.getByLabel('Bu seçimlerin mevcut sahipliğini', { exact: false }).check();
    await p.getByRole('button', { name: 'Onayla ve aktarımı yeniden doğrula', exact: true }).click();
  }
  await p.getByLabel('Mevcut çalışma alanının', { exact: false }).check(); await p.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).click();
}
async function assertLeaders(p, w) {
  await tab(p, 'Power Rankings');
  const a = selectDraftAnalysis(w, selectDraftWorkspace(w));
  for (const c of a.categories) {
    const rows = power(p).getByRole('region', { name: `${c.cat} güç sıralaması`, exact: true, includeHidden: true }).locator('li');
    assert.deepEqual(await rows.evaluateAll(els => els.map(el => ({ id: el.dataset.teamId, rank: el.querySelector('.power-rank').textContent, score: el.querySelector('.power-score').textContent }))), c.leaders.map(t => ({ id: t.teamId, rank: `${t.rank}.`, score: t.score.toFixed(2) })));
  }
}
test('empty league opens power and all ten rosters with nine explicit empty categories and visible explanation', async t => {
  const p = await open(t, configured());
  assert.ok(await power(p).locator('details').evaluate(d => d.open)); assert.ok(await rosters(p).locator(':scope > details').evaluate(d => d.open));
  assert.equal(await power(p).locator('.power-category').count(), 9); assert.equal(await power(p).locator('li').count(), 0);
  await tab(p, 'Power Rankings'); assert.equal(await power(p).getByText('Henüz puanlanabilir takım yok.', { exact: true }).count(), 9);
  assert.ok(await power(p).getByText(/Kesin sezon sonu sıralaması veya galibiyet olasılığı değildir/).isVisible());
  assert.equal(await rosters(p).locator('.team-roster[open]').count(), 10); assert.equal(await rosters(p).locator('[data-slot]').count(), 130);
  await tab(p, 'Kategori / Rakip Analizi'); await detail(p).getByText(/Henüz draft seçimi yok/).waitFor();
});
test('first assignment, transfer, removal and undo update engine leaders and roster dialog reuses validated commands', async t => {
  const p = await open(t, configured());
  await tab(p, 'Draft'); await player(p, 0).click(); await dialog(p).getByRole('button', { name: 'Ata', exact: true }).click();
  await assertLeaders(p, await inspect(p));
  assert.equal(await power(p).locator('.my-team').count(), 9);
  await tab(p, 'Takım Kadroları'); await team(p, 't0').getByRole('button', { name: 'Fixture Player 000', exact: true, includeHidden: true }).click();
  await dialog(p).getByLabel('Atanacak takım').selectOption('t2'); await dialog(p).getByRole('checkbox').check(); await dialog(p).getByRole('button', { name: 'Takımını değiştir', exact: true }).click();
  await assertLeaders(p, await inspect(p)); assert.equal(await power(p).locator('.my-team').count(), 0);
  await tab(p, 'Takım Kadroları'); await team(p, 't2').getByRole('button', { name: 'Fixture Player 000', exact: true, includeHidden: true }).click(); await dialog(p).getByRole('button', { name: 'Seçimi kaldır', exact: true }).click();
  assert.equal(await power(p).locator('li').count(), 0);
  await tab(p, 'Draft'); await player(p, 1).click(); await dialog(p).getByRole('button', { name: 'Ata', exact: true }).click();
  await p.getByRole('button', { name: 'Son seçimi geri al', exact: true }).click(); await dialog(p).getByRole('button', { name: 'Seçimi geri almayı onayla' }).click();
  assert.equal(await power(p).locator('li').count(), 0);
});
test('ties show engine rank skips, stable IDs and only five teams instead of legacy independent numbering', async t => {
  let w = draft(configured(), 10);
  // Identical projections for two teams; a third is lower. PTS engine ranks include a skip.
  const source = w.projections.find(p => p.playerId === 'p8');
  w = { ...w, teams: [...w.teams].reverse(), projections: w.projections.map(p => p.playerId === 'p7' ? { ...source, playerId: 'p7' } : p) };
  const p = await open(t, w); await assertLeaders(p, w);
  const ranks = await power(p).getByRole('region', { name: 'PTS güç sıralaması', exact: true, includeHidden: true }).locator('.power-rank').allTextContents();
  assert.deepEqual(ranks, ['1.', '2.', '2.', '4.', '5.']); assert.equal(await power(p).locator('li').count(), 45);
});
for (const name of ['early', 'middle', 'completed']) test(`fixed ${name} workspace renders engine category needs, opponents and all lineups`, async t => {
  const { workspace: w } = analysisFixture(name), p = await open(t, w), v = selectDraftWorkspace(w), a = selectDraftAnalysis(w, v);
  await assertLeaders(p, w);
  for (const c of a.categories) {
    const cells = await p.locator(`.category-analysis tr[data-category="${c.cat}"]`).locator('td').allTextContents();
    assert.equal(cells[1], c.score === null ? 'Hesaplanamıyor' : c.score.toFixed(2)); assert.equal(cells[2], c.rank === null ? '—' : `${c.rank}.`);
    assert.equal(cells[6], c.balance?.paceGap.toFixed(2) ?? '—'); assert.equal(cells[8], c.balance?.priority.toFixed(2) ?? '—');
    if (c.balance) assert.equal(cells[9], c.balance.status);
  }
  const rows = p.locator('.opponent-analysis tbody tr'); assert.equal(await rows.count(), v.opponents.length);
  for (let i = 0; i < v.opponents.length; i++) {
    const o = v.opponents[i], cells = await rows.nth(i).locator('td').allTextContents();
    assert.equal(cells[0], o.team); assert.equal(cells[2], `${o.gap > 0 ? '+' : ''}${o.gap.toFixed(2)}`);
    assert.equal(cells[3], o.ahead ? 'Rakip önde' : o.gap === 0 ? 'Eşit puan' : 'Rakip geride · yakın takipte'); assert.equal(cells[5], o.confidence);
  }
  for (const r of a.rosters) {
    const slots = team(p, r.id).locator('[data-slot]'); assert.deepEqual(await slots.evaluateAll(els => els.map(e => e.dataset.slot)), w.league.rules.rosterSlots);
    for (const s of r.slots) assert.equal(await slots.nth(s.index).locator('button').allTextContents().then(a => a.join()), s.player?.name ?? '');
  }
});
test('missing/excluded projections stay on rosters with separate counts, warnings and uncomputable scores', async t => {
  let w = draft(configured(), 2); w = { ...w, projections: w.projections.filter(p => p.playerId !== 'p0').map(p => p.playerId === 'p1' ? { playerId: p.playerId, datasetId: p.datasetId, status: 'excluded', reasons: ['invalid active'] } : p) };
  const p = await open(t, w); await tab(p, 'Takım Kadroları'); await team(p, 't0').getByText('Aktif projeksiyon yok.', { exact: true }).waitFor();
  await tab(p, 'Takım Kadroları'); await team(p, 't1').getByText('Analiz dışı: invalid active', { exact: true }).waitFor();
  assert.match(await team(p, 't0').locator('summary').innerText(), /1\/13 oyuncu · 0 geçerli projeksiyon/);
  await tab(p, 'Kategori / Rakip Analizi'); assert.equal(await power(p).locator('li').count(), 0); assert.equal(await p.locator('.category-analysis').getByText('Hesaplanamıyor', { exact: true }).count(), 9);
  await tab(p, 'Takım Kadroları'); await team(p, 't1').getByRole('button', { name: 'Fixture Player 001', exact: true, includeHidden: true }).click(); await dialog(p).getByRole('button', { name: 'Seçimi kaldır', exact: true }).waitFor();
});
test('all roster players remain accessible when engine cannot place them in a slot', async t => {
  let w = configured(); for (let i = 0; i < 13; i++) w = applyDraftCommand(w, { kind: 'assign', playerId: `p${i}`, teamId: 't0', confirmed: true });
  const p = await open(t, w); await tab(p, 'Takım Kadroları'); assert.equal(await team(p, 't0').getByRole('button').count(), 13);
  assert.ok(await team(p, 't0').locator('.unplaced button').count() > 0);
  await tab(p, 'Takım Kadroları'); await team(p, 't0').locator('.unplaced button').first().click(); await dialog(p).getByRole('button', { name: 'Takımını değiştir', exact: true }).waitFor();
});
test('strategy cancel/apply preserves picks and other strategies; updates needs/opponents/recommendations without changing raw power', async t => {
  const w = draft(configured(), 35), p = await open(t, w), before = await power(p).textContent();
  const suggestions = await p.locator('.recommendation-list').innerText();
  await p.getByRole('button', { name: 'Strateji', exact: true }).click(); await dialog(p).getByLabel('PTS', { exact: true }).selectOption('punt');
  await dialog(p).getByRole('button', { name: 'İptal', exact: true }).click(); assert.deepEqual((await inspect(p)).strategies, w.strategies);
  await p.getByRole('button', { name: 'Strateji', exact: true }).click(); await dialog(p).getByLabel('PTS', { exact: true }).selectOption('punt'); await dialog(p).getByLabel('AST', { exact: true }).selectOption('top1');
  await dialog(p).getByRole('button', { name: 'Hedefleri uygula', exact: true }).click();
  const next = await inspect(p); assert.deepEqual(next.draftSession, w.draftSession); assert.deepEqual(next.strategies.filter(s => s.teamId !== 't0'), w.strategies.filter(s => s.teamId !== 't0'));
  assert.equal(await power(p).textContent(), before); assert.notEqual(await p.locator('.recommendation-list').innerText(), suggestions);
  assert.equal(await p.locator('.opponent-analysis tbody tr').count(), selectDraftWorkspace(next).opponents.length);
  assert.equal(await p.locator('.category-analysis tr[data-category="PTS"] td').nth(8).innerText(), '—');
});
for (const [name, change, message] of [
  ['no valid own player', w => applyDraftCommand(w, { kind: 'assign', playerId: 'p0', teamId: 't1', confirmed: true }), /Takımınızda geçerli aktif/],
  ['unset', w => draft(fresh(), 1), /Kategori hedefi belirlenmemiş/],
  ['punt', w => applyDraftCommand(draft(fresh(), 1), { kind: 'strategy', targets: { ...w.strategies[0].targets, PTS: 'punt' } }), /Bütün hedefler Punt/],
  ['insufficient opponents', w => draft(w, 1), /Rakip karşılaştırması için yeterli veri yok/],
]) test(`opponent empty state: ${name}`, async t => { const p = await open(t, change(configured())); await tab(p, 'Kategori / Rakip Analizi'); await p.locator('.opponent-analysis').getByText(message).waitFor(); });
test('no threat is distinct from no comparison data and does not claim a win', async t => {
  let w = draft(configured(), 2);
  w = { ...w, projections: w.projections.map(p => p.playerId === 'p0' ? { ...p, stats: { ...p.stats, PTS: 10000 } } : p) };
  w = applyDraftCommand(w, { kind: 'strategy', targets: { ...fresh().strategies[0].targets, PTS: 'top1' } });
  const p = await open(t, w); await tab(p, 'Kategori / Rakip Analizi'); await p.locator('.opponent-analysis').getByText(/Bu, kategorileri kazanacağınız anlamına gelmez/).waitFor();
});
test('keyboard collapse, search, pagination and dialogs never recalculate model or persist temporary state', async t => {
  const w = draft(configured(), 12), p = await open(t, w);
  const count = await p.evaluate(() => globalThis.__modelCalls); assert.ok(count > 0);
  for (const [name, region] of [['Power Rankings', power(p)], ['Takım Kadroları', rosters(p)], ['Kategori / Rakip Analizi', detail(p)]]) {
    await tab(p, name);
    const summary = region.locator(':scope > details > summary'); await summary.focus(); await p.keyboard.press('Enter'); assert.equal(await region.locator(':scope > details').evaluate(d => d.open), false);
    await p.keyboard.press('Space'); assert.equal(await region.locator(':scope > details').evaluate(d => d.open), true);
  }
  await tab(p, 'Takım Kadroları'); const summary = team(p, 't0').locator('summary'); await summary.focus(); await p.keyboard.press('Enter'); await p.keyboard.press('Enter');
  const opener = team(p, 't0').getByRole('button').first(); await opener.focus(); await p.keyboard.press('Enter'); await dialog(p).waitFor(); await p.keyboard.press('Escape'); assert.ok(await opener.evaluate(b => document.activeElement === b));
  await tab(p, 'Draft'); await p.getByLabel('Oyuncu ara', { exact: true }).fill('Player 010'); await p.getByLabel('Oyuncu ara', { exact: true }).fill(''); await p.getByRole('button', { name: 'Sonraki', exact: true }).click();
  await p.getByRole('button', { name: 'Strateji', exact: true }).click(); await p.keyboard.press('Escape');
  assert.equal(await p.evaluate(() => globalThis.__modelCalls), count); assert.deepEqual(await inspect(p), w);
  assert.deepEqual(await p.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key), w);
});
test('stage 12: locked dataset keeps power, rosters and needs unchanged while navigating home', async t => {
 const initial=draft(configured(),2),p=await open(t,initial),before=await inspect(p);
 await settings(p);assert.ok(await p.getByRole('button',{name:'Oyuncu havuzunu değiştir',exact:true}).isDisabled());
 await p.getByRole('link',{name:'NBA Fantasy Assistant',exact:true}).click();await p.getByRole('button',{name:'Draft Asistanı Ligini oluştur',exact:false}).click();
 await p.getByRole('button',{name:'Mevcut çalışmaya devam et',exact:true}).click();assert.deepEqual(await inspect(p),before);await assertLeaders(p,before);
});
test('save/reload and JSON restore rederive identical analyses, while legacy v3 backups also render', async t => {
  const w = draft(configured(), 35), p = await open(t, w), before = await power(p).textContent(), needs = await p.locator('.category-analysis').textContent();
  await p.getByRole('button', { name: 'Kaydet', exact: true }).click(); await p.getByRole('status').filter({ hasText: 'Çalışma alanı kaydedildi.' }).waitFor(); await p.reload();
  await tab(p, 'Power Rankings'); await power(p).waitFor(); assert.equal(await power(p).textContent(), before); assert.equal(await p.locator('.category-analysis').textContent(), needs);
  await restore(p, configured()); assert.equal(await power(p).locator('li').count(), 0); await restore(p, w); assert.equal(await power(p).textContent(), before);
  const legacy = JSON.parse(await readFile(new URL('../fixtures/persistence/v3-backup.json', import.meta.url), 'utf8')); await restore(p, legacy);
  const migrated = await inspect(p); assert.equal(await rosters(p).locator('.team-roster').count(), 10); await assertLeaders(p, migrated);
});
for (const width of [280, 375, 1280]) test(`real Chromium analysis layout, keyboard scrolling and screenshots at ${width}px`, async t => {
  const { workspace: w } = analysisFixture('middle'), p = await open(t, w, width);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const boxes = await p.locator('.pool-panel, .recommendations-panel').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom, right: r.right }; }));
  if (width >= 1280) { assert.ok(boxes[1].x > boxes[0].right); assert.ok(Math.abs(boxes[1].y-boxes[0].y) <= 2); }
  else assert.ok(boxes[1].y >= boxes[0].bottom, 'recommendations follow the pool on narrow screens');
  await tab(p, 'Power Rankings'); const scroll = power(p).getByRole('region', { name: 'Dokuz kategori güç sıralaması', exact: true }); await scroll.focus(); await p.keyboard.press('End'); await scroll.evaluate(e => { e.scrollLeft = e.scrollWidth; });
  assert.ok(await scroll.evaluate(e => e.scrollWidth <= e.clientWidth || e.scrollLeft > 0)); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await scroll.evaluate(e => { e.scrollLeft = 0; });
  await p.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); }); await p.screenshot({ path: `artifacts/ui/analysis-desktop-${width}.png` });
  await tab(p, 'Takım Kadroları'); await team(p, 't0').screenshot({ path: `artifacts/ui/analysis-team-${width}.png` });
  await rosters(p).screenshot({ path: `artifacts/ui/analysis-rosters-${width}.png` });
  await tab(p, 'Kategori / Rakip Analizi'); await detail(p).screenshot({ path: `artifacts/ui/analysis-detail-${width}.png` });
  for (const [name, section] of [['Takım Kadroları',rosters(p)], ['Kategori / Rakip Analizi',detail(p)]]) { await tab(p, name); await section.locator(':scope > details > summary').click(); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
});
