import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';

const engines = (process.env.BROWSER_ENGINES || 'chromium').split(',');
const key = 'nba-fantasy-assistant.session.v1';
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
async function open(t, engine, width = 1280, seed) {
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'tr-TR' });
  if (seed) await context.addInitScript(({ key, seed }) => { if (!sessionStorage.seeded) { sessionStorage.setItem(key, JSON.stringify(seed)); sessionStorage.seeded = '1'; } }, { key, seed });
  const p = await context.newPage(); p.setDefaultTimeout(10000);
  const errors = []; p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await p.goto(base); return p;
}
const home = p => p.getByRole('link', { name: 'NBA Fantasy Assistant', exact: true });
const rankingsTable = p => p.getByRole('region', { name: 'SportsDataverse oyuncu istatistikleri', exact: true }).getByRole('table');
const background = locator => locator.evaluate(e => getComputedStyle(e).backgroundColor);
const HIGHLIGHT = 'rgb(255, 243, 197)';
// Hover/focus styles can apply a frame after the pointer event; poll briefly.
const waitHighlight = async locator => { const handle = await locator.elementHandle(); await locator.page().waitForFunction(([e, color]) => getComputedStyle(e).backgroundColor === color, [handle, HIGHLIGHT], { timeout: 3000 }); };
const firstPlayer = async p => (await rankingsTable(p).locator('tbody tr').first().locator('td').nth(1).innerText()).trim();

for (const engine of engines) {
  test(`${engine}: whole sortable header cell sorts and highlights only the hovered cell`, async t => {
    const p = await open(t, engine);
    await p.getByRole('button', { name: 'Oyuncu Sıralamaları Oyuncu', exact: false }).click();
    const table = rankingsTable(p); await table.locator('tbody tr').first().waitFor();
    // Header rows can be taller than one sort button (fonts, wrapping); the whole cell must still sort.
    await p.addStyleTag({ content: '.player-table-frame .player-table thead th { height: 72px; }' });
    const header = name => table.locator('thead th').filter({ has: p.getByRole('button', { name, exact: true }) });
    const pts = header('PTS'), nameHeader = header('OYUNCU ADI');
    const idle = await background(pts);
    // Point near the cell's lower corner, away from the label text.
    const box = await pts.boundingBox();
    await p.mouse.move(box.x + 3, box.y + box.height - 3);
    await waitHighlight(pts);
    assert.notEqual(await background(nameHeader), 'rgb(255, 243, 197)', 'the name header no longer lights up for other headers');
    assert.notEqual(idle, 'rgb(255, 243, 197)');
    assert.equal(await pts.getAttribute('aria-sort'), 'none');
    await p.mouse.click(box.x + 3, box.y + box.height - 3);
    assert.equal(await pts.getAttribute('aria-sort'), 'ascending');
    const ascendingFirst = await firstPlayer(p);
    await p.mouse.click(box.x + box.width - 3, box.y + 3);
    assert.equal(await pts.getAttribute('aria-sort'), 'descending');
    assert.notEqual(await firstPlayer(p), ascendingFirst);
    // Keyboard and screen readers still use the named button with aria-sort on its cell.
    const reb = header('REB');
    await reb.getByRole('button').focus(); await p.keyboard.press('Enter');
    assert.equal(await reb.getAttribute('aria-sort'), 'ascending');
    await waitHighlight(reb); // keyboard focus shows the same highlight
    await p.keyboard.press('Space');
    assert.equal(await reb.getAttribute('aria-sort'), 'descending');
  });

  test(`${engine}: title link returns to the main menu during a draft without losing data`, async t => {
    const raw = fresh(30), seed = { ...applyDraftCommand(raw, { kind: 'strategy', targets: { ...raw.strategies[0].targets, PTS: 'top3' } }), manualDraftLocked: true };
    const p = await open(t, engine, 375, seed);
    await p.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).click();
    await p.getByRole('button', { name: 'Mevcut çalışmaya devam et' }).click();
    await p.getByRole('region', { name: 'Oyuncu istatistik tablosu', exact: true }).getByRole('button', { name: 'Fixture Player 000', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Ata', exact: true }).click();
    await p.getByLabel('Oyuncu ara', { exact: true }).fill('Player 001');
    const saved = await p.evaluate(k => sessionStorage.getItem(k), key);
    assert.equal(JSON.parse(saved).draftSession.picks.length, 1);
    assert.equal(await p.getByRole('button', { name: /Ana ekrana dön/ }).count(), 0);
    await home(p).click();
    await p.getByRole('heading', { name: 'Nasıl devam etmek istersin?' }).waitFor();
    assert.equal(await p.evaluate(k => sessionStorage.getItem(k), key), saved);
    await p.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).click();
    await p.getByRole('button', { name: 'Mevcut çalışmaya devam et' }).click();
    assert.equal(await p.getByLabel('Oyuncu ara', { exact: true }).inputValue(), 'Player 001');
    assert.equal(await p.evaluate(k => sessionStorage.getItem(k), key), saved);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
}
