import { enterDraft, recovery, settings, importPool, tab } from '../helpers/workspaceUi.mjs';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { draftStatus, selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { createWorkbook } from '../../src/infrastructure/projections/workbook.ts';
const key = 'nba-fantasy-assistant.session.v1';
const configured = n => { const w = { ...fresh(n), manualDraftLocked: true }; return applyDraftCommand(w, { kind: 'strategy', targets: { ...w.strategies[0].targets, PTS: 'top3', AST: 'top5', 'FG%': 'top7' } }); };
const draft = (w, count) => { for (let i = 0; i < count; i++) w = applyDraftCommand(w, { kind: 'assign', playerId: `p${i}`, teamId: draftStatus(w).teamId }); return w; };
let server, browser, base;
before(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true }); await mkdir('artifacts/ui', { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(t, initial = configured(), width = 1280, failure, ready = true) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR' }); t.after(() => context.close());
  await context.addInitScript(({ key, initial, failure }) => {
    if (!sessionStorage.seeded) { sessionStorage.setItem(key, JSON.stringify(initial)); sessionStorage.seeded = '1'; }
    if (failure) { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k === key) throw new DOMException('test failure', failure); return original.call(this, k, v); }; }
  }, { key, initial, failure });
  const page = await context.newPage(); page.setDefaultTimeout(8000); const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(base); await enterDraft(page); if (ready) await page.getByRole('heading', { name: 'Oyuncu havuzu', exact: true }).waitFor(); else await page.getByRole('heading', { name: 'Draft için hazırlan' }).waitFor(); return page;
}
const pool = page => page.getByRole('region', { name: 'Oyuncu istatistik tablosu', exact: true });
const dialog = page => page.getByRole('dialog');
const status = page => page.getByRole('status', { name: 'Draft sırası' });
const player = (page, i) => pool(page).getByRole('button', { name: `Fixture Player ${String(i).padStart(3, '0')}`, exact: true });
async function inspect(page) { await recovery(page); const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'JSON yedeğini indir', exact: true }).click(); const dl = await event; return JSON.parse(await readFile(await dl.path(), 'utf8')); }
async function save(page) { await page.getByRole('button', { name: 'Kaydet', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Çalışma alanı kaydedildi.' }).waitFor(); }
async function assign(page, i) { await player(page, i).click(); await dialog(page).getByRole('button', { name: 'Ata', exact: true }).click(); await dialog(page).waitFor({ state: 'hidden' }); }
async function restore(page, w) { await recovery(page);
  await page.getByLabel('JSON yedeği seç', { exact: true }).setInputFiles({ name: 'draft.json', buffer: Buffer.from(JSON.stringify(w)) });
  await page.getByRole('button', { name: 'Yedeği önizle', exact: true }).click();
  await page.getByLabel('Mevcut çalışma alanının', { exact: false }).check();
  await page.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).click();
}

test('empty league has distinct no-upload state and disabled last-pick undo', async t => {
  const w = fresh(0); const page = await open(t, { ...w, datasets: [], league: { ...w.league, activeDatasetId: null } }, 1280, undefined, false);
  assert.equal(await page.getByRole('tab').count(), 0);
  await page.getByText('Stratejiyi tamamlamak için', { exact: false }).waitFor();
  assert.equal(await page.locator('.setup-step').count(), 3);
});
test('pool search, exact G position, draft filters, sorting, missing values and pagination', async t => {
  const page = await open(t, draft(configured(), 2));
  assert.equal(await pool(page).locator('tbody tr').count(), 50);
  await page.getByRole('button', { name: 'Sonraki', exact: true }).click(); await player(page, 50).waitFor();
  await page.getByLabel('Oyuncu ara', { exact: true }).fill('Player 003'); assert.equal(await pool(page).locator('tbody tr').count(), 1);
  await page.getByLabel('Pozisyon', { exact: true }).selectOption('PG'); assert.equal(await pool(page).locator('tbody tr').count(), 0);
  await page.getByLabel('Pozisyon', { exact: true }).selectOption('G'); assert.equal(await pool(page).locator('tbody tr').count(), 1);
  await page.getByLabel('Oyuncu ara', { exact: true }).fill(''); await page.getByLabel('Pozisyon', { exact: true }).selectOption('');
  await page.getByLabel('Draft filtresi', { exact: true }).selectOption('picked'); assert.equal(await pool(page).locator('tbody tr').count(), 2);
  await page.getByLabel('Draft filtresi', { exact: true }).selectOption('mine'); assert.equal(await pool(page).locator('tbody tr').count(), 1);
  await page.getByLabel('Draft filtresi', { exact: true }).selectOption('available'); assert.equal(await player(page, 0).count(), 0);
  await page.getByLabel('Sıralama', { exact: true }).selectOption('PTS'); await page.getByRole('button', { name: 'Sıralama yönünü değiştir' }).click();
  assert.match(await pool(page).locator('tbody tr').first().innerText(), /Player 139/);
  await page.getByLabel('Sıralama', { exact: true }).selectOption('OYUNCU ADI'); assert.match(await pool(page).locator('tbody tr').first().innerText(), /Player 139/);
});
for (const unit of ['perGame', 'totals']) test(`table and assignment dialog display correct ${unit} unit and computed percentages`, async t => {
  const w = configured(2); const page = await open(t, { ...w, datasets: [{ ...w.datasets[0], unit }] });
  await page.locator('.pool-panel').getByText(unit === 'perGame' ? /Maç başına/ : /Sezon toplamı/).waitFor();
  const row = pool(page).locator('tbody tr').first(); assert.match(await row.innerText(), /50.0%/); assert.match(await row.innerText(), /75.0%/);
  await player(page, 0).click(); assert.equal(await dialog(page).getByText('50.0%', { exact: true }).count(), 1);
  await dialog(page).getByText(unit === 'perGame' ? 'Maç başına (perGame)' : 'Sezon toplamı (totals)', { exact: true }).waitFor();
});
test('excluded and missing active projections remain visible with original owners and no fabricated stats', async t => {
  let w = draft(configured(4), 2);
  w = { ...w, projections: w.projections.filter(p => p.playerId !== 'p0').map(p => p.playerId === 'p1' ? { playerId: p.playerId, datasetId: p.datasetId, status: 'excluded', reasons: ['invalid fixture'] } : p) };
  const page = await open(t, w); await page.getByLabel('Draft filtresi', { exact: true }).selectOption('picked');
  assert.equal(await pool(page).locator('tbody tr').count(), 2); assert.match(await pool(page).locator('tbody tr').first().innerText(), /Aktif projeksiyon yok/);
  await player(page, 0).click(); await dialog(page).getByText(/Seçili: Fixture Team 0/).waitFor(); await page.keyboard.press('Escape');
  await player(page, 1).click(); await dialog(page).getByText('Analiz dışı: invalid fixture', { exact: true }).waitFor();
});
test('first snake default, out-of-turn explicit consent, transfer consent reset, historical deletion and undo', async t => {
  const initial = configured(8); const page = await open(t, initial);
  await player(page, 0).click(); assert.equal(await dialog(page).getByLabel('Atanacak takım').inputValue(), 't0');
  await dialog(page).getByLabel('Atanacak takım').selectOption('t2'); assert.ok(await dialog(page).getByRole('button', { name: 'Ata', exact: true }).isDisabled());
  await dialog(page).getByRole('checkbox').check(); await dialog(page).getByRole('button', { name: 'Ata', exact: true }).click();
  let next = await inspect(page); assert.equal(next.draftSession.picks[0].outOfTurnConfirmed, true); assert.equal(next.draftSession.picks[0].teamId, 't2');
  await player(page, 0).click(); await dialog(page).getByLabel('Atanacak takım').selectOption('t3');
  assert.ok(await dialog(page).getByRole('button', { name: 'Takımını değiştir', exact: true }).isDisabled()); assert.ok(!await dialog(page).getByRole('checkbox').isChecked());
  await dialog(page).getByRole('checkbox').check(); await dialog(page).getByRole('button', { name: 'Takımını değiştir', exact: true }).click();
  next = await inspect(page); assert.deepEqual(next.draftSession.picks, [{ playerId: 'p0', teamId: 't3', selectionIndex: 0, outOfTurnConfirmed: true }]);
  await assign(page, 1); await assign(page, 2);
  await player(page, 1).click(); await dialog(page).getByRole('button', { name: 'Seçimi kaldır', exact: true }).click();
  next = await inspect(page); assert.deepEqual(next.draftSession.picks.map(p => p.selectionIndex), [0, 2]);
  await page.getByRole('button', { name: 'Son seçimi geri al', exact: true }).click(); await dialog(page).getByText(/Player 002 · Fixture Team 2/).waitFor();
  await dialog(page).getByRole('button', { name: 'İptal', exact: true }).click(); assert.equal((await inspect(page)).draftSession.picks.length, 2);
  await page.getByRole('button', { name: 'Son seçimi geri al', exact: true }).click(); await dialog(page).getByRole('button', { name: 'Seçimi geri almayı onayla' }).click();
  next = await inspect(page); assert.equal(next.draftSession.picks.length, 1); assert.equal(next.draftSession.picks[0].outOfTurnConfirmed, true);
  assert.match(await status(page).innerText(), /Seçim 2\/130 · Tur 1 · Sıradaki: Fixture Team 1/);
});
test('10th and 11th picks reverse snake immediately; started order remains locked', async t => {
  const page = await open(t, draft(configured(), 9)); await assign(page, 9);
  assert.match(await status(page).innerText(), /Seçim 11\/130 · Tur 2 · Sıradaki: Fixture Team 9/);
  await assign(page, 10); assert.match(await status(page).innerText(), /Sıradaki: Fixture Team 8/);
  await settings(page); await page.getByRole('button', { name: 'Lig bilgilerini düzenle', exact: true }).click(); assert.equal(await page.locator('.move-buttons button:disabled').count(), 20);
});
test('full team rejects assignment and transfer while full draft never displays selection 131 or round 14', async t => {
  let w = configured(); for (let i = 0; i < 13; i++) w = applyDraftCommand(w, { kind: 'assign', playerId: `p${i}`, teamId: 't0', confirmed: true });
  const page = await open(t, w); await player(page, 13).click(); await dialog(page).getByLabel('Atanacak takım').selectOption('t0');
  await dialog(page).getByText('Takımın kadrosu dolu.', { exact: true }).waitFor(); assert.ok(await dialog(page).getByRole('button', { name: 'Ata', exact: true }).isDisabled());
  await page.keyboard.press('Escape'); await restore(page, draft(configured(), 130)); await status(page).getByText('Draft tamamlandı · 130/130', { exact: true }).waitFor();
  assert.doesNotMatch(await status(page).innerText(), /131|Tur 14/);
  await page.getByLabel('Oyuncu ara', { exact: true }).fill('Player 130'); await player(page, 130).click(); assert.ok(await dialog(page).getByRole('button', { name: 'Ata', exact: true }).isDisabled());
});
test('strategy cancel, all unset/punt, real engine recommendations, fewer than five and draft recalculation', async t => {
  const initial = draft(fresh(5), 1), page = await open(t, initial);
  await page.locator('.recommendations-panel').getByText(/Kategori hedefleri belirlenmedi/).waitFor();
  await page.getByRole('button', { name: 'Strateji', exact: true }).click(); await dialog(page).getByLabel('PTS', { exact: true }).selectOption('top1');
  await dialog(page).getByRole('button', { name: 'İptal', exact: true }).click(); assert.deepEqual((await inspect(page)).strategies, initial.strategies);
  await page.getByRole('button', { name: 'Strateji', exact: true }).click();
  // The dialog suggests İlk 5 for a team without targets; reproduce the all unset/punt case explicitly.
  for (const c of ['FG%', 'FT%', '3PM', 'REB', 'AST', 'STL', 'BLK', 'TO']) await dialog(page).getByLabel(c, { exact: true }).selectOption('unset');
  await dialog(page).getByLabel('PTS', { exact: true }).selectOption('punt');
  await dialog(page).getByRole('button', { name: 'Hedefleri uygula', exact: true }).click(); await page.locator('.recommendations-panel').getByText(/Bütün kategoriler unset\/punt/).waitFor();
  await page.getByRole('button', { name: 'Strateji', exact: true }).click(); await dialog(page).getByLabel('PTS', { exact: true }).selectOption('top1');
  await dialog(page).getByRole('button', { name: 'Hedefleri uygula', exact: true }).click();
  let w = await inspect(page), v = selectDraftWorkspace(w); assert.equal(await page.locator('.recommendation-list > li').count(), 4);
  const labels = await page.locator('.recommendation-list .player-link').allTextContents(); assert.deepEqual(labels, v.topFive.map((r, i) => `${i + 1}. ${w.players.find(p => p.id === r.playerId).name}`));
  await page.locator('.recommendation-list .player-link').first().click(); await dialog(page).getByRole('button', { name: 'Ata', exact: true }).click();
  w = await inspect(page); v = selectDraftWorkspace(w); assert.equal(await page.locator('.recommendation-list > li').count(), 3);
  assert.deepEqual(await page.locator('.recommendation-list .player-link').allTextContents(), v.topFive.map((r, i) => `${i + 1}. ${w.players.find(p => p.id === r.playerId).name}`));
});
for (const failure of [undefined, 'QuotaExceededError', 'SecurityError']) test(`draft and targets survive ${failure ?? 'save/reload'} and JSON restoration`, async t => {
  const initial = configured(6), page = await open(t, initial, 375, failure); await assign(page, 0);
  await page.getByRole('button', { name: 'Strateji', exact: true }).click(); await dialog(page).getByLabel('TO', { exact: true }).selectOption('top1'); await dialog(page).getByRole('button', { name: 'Hedefleri uygula', exact: true }).click();
  const current = await inspect(page); await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  if (failure) { await page.getByRole('status').filter({ hasText: 'Kaydedilemedi.' }).waitFor(); assert.deepEqual(await page.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key), initial); assert.deepEqual(await inspect(page), current); }
  else { await page.getByRole('status').filter({ hasText: 'Çalışma alanı kaydedildi.' }).waitFor(); await page.reload(); await player(page, 0).waitFor(); assert.deepEqual(await inspect(page), current); }
  await restore(page, current); assert.deepEqual(await inspect(page), current);
});
test('stage 12: locked draft rejects pool replacement and retains recommendations and picks', async t => {
 const initial=draft(configured(8),2), page=await open(t,initial);
 const before=await inspect(page); await settings(page);
 assert.ok(await page.getByRole('button',{name:'Oyuncu havuzunu değiştir',exact:true}).isDisabled());
 assert.equal(await page.getByRole('button',{name:'Oyuncu havuzunu sıfırla',exact:true}).count(),0);
 assert.equal(await page.getByLabel('Oyuncu projeksiyonu dosyası').count(),0);
 assert.deepEqual(await inspect(page),before); assert.deepEqual(selectDraftWorkspace(before).topFive,selectDraftWorkspace(initial).topFive);
});
test('keyboard dialog has focus containment, Escape, inert background and opener restoration', async t => {
  const page = await open(t, configured(5), 375); const opener = player(page, 0); await opener.focus(); await page.keyboard.press('Enter');
  await dialog(page).waitFor(); assert.ok(await dialog(page).evaluate(d => d.contains(document.activeElement)));
  for (let i = 0; i < 12; i++) { await page.keyboard.press(i % 3 ? 'Tab' : 'Shift+Tab'); assert.ok(await dialog(page).evaluate(d => d.contains(document.activeElement))); }
  assert.ok(await page.getByRole('button', { name: 'Kaydet', exact: true, includeHidden: true }).evaluate(b => { b.focus(); return document.activeElement !== b; }));
  await page.keyboard.press('Escape'); assert.ok(await opener.evaluate(b => document.activeElement === b)); assert.equal(await dialog(page).count(), 0);
  await opener.press('Enter'); await dialog(page).getByRole('button', { name: 'Pencereyi kapat' }).click(); assert.ok(await opener.evaluate(b => document.activeElement === b));
});
test('stale open modal cannot act after an accepted workspace replacement', async t => {
  // A native modal blocks user background interaction; exercise the revision guard with a replacement.
  const page = await open(t, configured(5));
  const other = configured(5); other.league.name = 'Replacement Fixture';
  await recovery(page); await page.getByLabel('JSON yedeği seç', { exact: true }).setInputFiles({ name: 'replacement.json', buffer: Buffer.from(JSON.stringify(other)) });
  await page.getByRole('button', { name: 'Yedeği önizle', exact: true }).click(); await page.getByLabel('Mevcut çalışma alanının', { exact: false }).check();
  await player(page, 0).click();
  // Dispatch a background operation programmatically to exercise the revision guard.
  await page.getByRole('button', { name: 'Yedeği geri yükle', exact: true, includeHidden: true }).evaluate(b => b.click());
  await dialog(page).getByRole('alert').filter({ hasText: 'Çalışma alanı değişti' }).waitFor(); assert.ok(await dialog(page).getByRole('button', { name: 'Ata', exact: true }).isDisabled());
  await page.keyboard.press('Escape'); assert.equal((await inspect(page)).draftSession.picks.length, 0);
});
for (const width of [280, 375, 1280]) test(`draft pool, recommendations and mobile modal fit ${width}px`, async t => {
  const page = await open(t, draft(configured(), 6), width);
  const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${width}`);
  await fits();
  const boxes = await page.locator('.pool-panel, .recommendations-panel').evaluateAll(items => items.map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, bottom: el.getBoundingClientRect().bottom, right: el.getBoundingClientRect().right })));
  if (width >= 1280) { assert.ok(boxes[1].x > boxes[0].right); assert.ok(Math.abs(boxes[1].y-boxes[0].y) <= 2); }
  else assert.ok(boxes[1].y >= boxes[0].bottom);
  await page.screenshot({ path: `artifacts/ui/draft-workspace-${width}.png`, fullPage: true });
  if (width === 1280) await page.screenshot({ path: `artifacts/ui/draft-desktop-${width}.png` });
  await player(page, 6).click(); await dialog(page).getByLabel('Atanacak takım').selectOption('t2'); await fits();
  assert.ok(await dialog(page).evaluate(d => { const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
  await page.screenshot({ path: `artifacts/ui/draft-modal-${width}.png`, fullPage: false });
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Strateji', exact: true }).click(); await fits();
});

for (const width of [280, 375, 1280]) test(`pool headers and player column stay pinned during keyboard and two-axis scrolling at ${width}px`, async t => {
  const initial = draft(configured(), 6);
  // Long user-supplied team names also exercise horizontal overflow on desktop.
  initial.teams = initial.teams.map(team => ({ ...team, name: `${team.name} International Basketball Association Western Conference Draft Management` }));
  const page = await open(t, initial, width);
  const region = pool(page);
  const settleScroll = () => region.evaluate(el => new Promise(resolve => {
    let x = el.scrollLeft, y = el.scrollTop, stableFrames = 0;
    const frame = () => {
      stableFrames = x === el.scrollLeft && y === el.scrollTop ? stableFrames + 1 : 0;
      x = el.scrollLeft; y = el.scrollTop;
      if (stableFrames >= 4) resolve(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  await region.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Sıralama yönünü değiştir' }).focus();
  // Pagination and the top scrollbar now precede the table in keyboard order.
  for (let i=0; i<8 && !await region.evaluate(el => document.activeElement === el); i++) await page.keyboard.press('Tab');
  assert.ok(await region.evaluate(el => document.activeElement === el), 'Tab reaches the scroll region');
  const dimensions = await region.evaluate(el => ({ height: el.clientHeight, width: el.clientWidth, contentHeight: el.scrollHeight, contentWidth: el.scrollWidth }));
  assert.ok(dimensions.contentHeight > dimensions.height, 'table has its own vertical scroll range');
  if (width < 1000) assert.ok(dimensions.contentWidth > dimensions.width + 160, `table has a horizontal scroll range: ${JSON.stringify(dimensions)}`);
  const corner = region.getByRole('columnheader', { name: 'OYUNCU ADI', exact: true });
  const headerTop = (await corner.boundingBox()).y;
  const rowTop = (await region.locator('tbody tr').first().boundingBox()).y;
  const pageScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => document.querySelector('.pool-scroll').scrollTop > 100);
  await settleScroll();
  // Freeze the keyboard scroll at a precise offset for stable geometry comparisons.
  await region.evaluate(el => el.scrollTo({ top: 240, left: 80, behavior: 'instant' }));
  const before = await region.evaluate(el => {
    const header = el.querySelector('thead .player-name').getBoundingClientRect();
    const name = [...el.querySelectorAll('tbody .player-name')].find(cell => {
      const r = cell.getBoundingClientRect(); return r.top >= header.bottom && r.bottom <= el.getBoundingClientRect().bottom;
    });
    return { headerTop: header.top, headerLeft: header.left, nameLeft: name.getBoundingClientRect().left,
      nameIndex: [...el.querySelectorAll('tbody .player-name')].indexOf(name),
      numericLeft: el.querySelector('thead th:nth-child(5)').getBoundingClientRect().left,
      scrollLeft: el.scrollLeft };
  });
  assert.ok(Math.abs(before.headerTop - headerTop) <= 1, 'column header stays at the same screen Y after vertical scrolling');
  assert.ok((await region.locator('tbody tr').first().boundingBox()).y < rowTop - 100, 'body rows actually move vertically');
  // Right Arrow must scroll the focused region without moving the page.
  await page.keyboard.press('ArrowRight');
  if (dimensions.contentWidth > dimensions.width) await page.waitForFunction(() => document.querySelector('.pool-scroll').scrollLeft > 80);
  await settleScroll();
  await region.evaluate(el => el.scrollTo({ top: 480, left: 160, behavior: 'instant' }));
  const after = await region.evaluate((el, index) => {
    const corner = el.querySelector('thead .player-name'), name = el.querySelectorAll('tbody .player-name')[index];
    const r = corner.getBoundingClientRect(), bounds = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
    const headers = [...el.querySelectorAll('thead th')];
    // Test the painted header to the right of the pinned name, where moving rows pass underneath.
    const visibleHeader = headers.find(cell => {
      const rect = cell.getBoundingClientRect(); return cell !== corner && rect.right > r.right + 2 && rect.left < bounds.right - 2;
    });
    if (!visibleHeader) throw new Error('A numeric header must remain visible beside the pinned name');
    const h = visibleHeader.getBoundingClientRect();
    return { headerTop: r.top, headerLeft: r.left, nameLeft: name.getBoundingClientRect().left,
      numericLeft: el.querySelector('thead th:nth-child(5)').getBoundingClientRect().left,
      scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, regionLeft: bounds.left,
      cornerOnTop: hit === corner || corner.contains(hit),
      headerOnTop: visibleHeader.contains(document.elementFromPoint(Math.min(bounds.right - 2, Math.max(r.right + 2, h.left + 3)), h.top + h.height / 2)),
      opaqueCorner: getComputedStyle(corner).backgroundColor !== 'rgba(0, 0, 0, 0)',
      opaqueHeader: getComputedStyle(visibleHeader).backgroundColor !== 'rgba(0, 0, 0, 0)' };
  }, before.nameIndex);
  assert.equal(after.scrollTop, 480);
  assert.ok(Math.abs(after.headerTop - headerTop) <= 1, 'header remains pinned after combined scrolling');
  assert.ok(Math.abs(after.headerLeft - before.headerLeft) <= 1, 'corner remains pinned horizontally');
  assert.ok(Math.abs(after.nameLeft - before.nameLeft) <= 1, 'body player column remains pinned horizontally');
  assert.ok(width >= 1000 || Math.abs(after.nameLeft - after.regionLeft) <= 1, 'player column is pinned to the region edge');
  assert.ok(Math.abs(before.numericLeft - after.numericLeft - (after.scrollLeft - before.scrollLeft)) <= 1, 'stat columns actually move horizontally');
  assert.ok(after.cornerOnTop && after.headerOnTop, 'header and corner paint above intersecting cells');
  assert.ok(after.opaqueCorner && after.opaqueHeader, 'sticky cells have opaque backgrounds');
  assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), pageScroll, 'keyboard scroll stays within the table');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page has no horizontal overflow');
  await page.screenshot({ path: `artifacts/ui/draft-sticky-${width}.png` });
});
