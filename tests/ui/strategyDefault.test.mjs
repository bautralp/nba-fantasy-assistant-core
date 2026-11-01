import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';

const engines = (process.env.BROWSER_ENGINES || 'chromium').split(',');
const key = 'nba-fantasy-assistant.session.v1';
const categories = ['FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO'];
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
async function open(t, engine, seed, width = 1280) {
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'tr-TR' });
  await context.addInitScript(({ key, seed }) => { if (!sessionStorage.seeded) { sessionStorage.setItem(key, JSON.stringify(seed)); sessionStorage.seeded = '1'; } }, { key, seed });
  const p = await context.newPage(); p.setDefaultTimeout(10000);
  const errors = []; p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await p.goto(base);
  await p.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).click();
  await p.getByRole('button', { name: 'Mevcut çalışmaya devam et' }).click();
  await p.locator('#page-heading-draft').waitFor({ state: 'visible' });
  return p;
}
const stored = p => p.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key);
const dialogValues = async d => Object.fromEntries(await Promise.all(categories.map(async c => [c, await d.getByLabel(c, { exact: true }).inputValue()])));

for (const engine of engines) {
  test(`${engine}: a team without targets sees İlk 5 everywhere; nothing is stored until applied`, async t => {
    const seed = fresh(30), p = await open(t, engine, seed, 375);
    await p.getByRole('button', { name: /Stratejini belirle/ }).click();
    const d = p.getByRole('dialog');
    assert.deepEqual(await dialogValues(d), Object.fromEntries(categories.map(c => [c, 'top5'])));
    await d.getByText(/başlangıç önerisi olarak tüm kategoriler İlk 5/).waitFor();
    await d.getByRole('button', { name: 'İptal', exact: true }).click();
    assert.deepEqual((await stored(p)).strategies, seed.strategies, 'cancel keeps every stored target unset');
    await p.getByRole('button', { name: /Stratejini belirle/ }).click();
    assert.equal(await d.getByLabel('AST', { exact: true }).inputValue(), 'top5');
    await d.getByLabel('TO', { exact: true }).selectOption('punt');
    await d.getByRole('button', { name: 'Hedefleri uygula', exact: true }).click();
    const after = await stored(p);
    assert.deepEqual(after.strategies.find(s => s.teamId === 't0').targets, { ...Object.fromEntries(categories.map(c => [c, 'top5'])), TO: 'punt' });
    assert.deepEqual(after.strategies.filter(s => s.teamId !== 't0'), seed.strategies.filter(s => s.teamId !== 't0'), 'other teams keep unset targets');
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });

  test(`${engine}: existing targets open unchanged without the İlk 5 suggestion`, async t => {
    const raw = fresh(30), seed = applyDraftCommand(raw, { kind: 'strategy', targets: { ...raw.strategies[0].targets, PTS: 'top3' } });
    const p = await open(t, engine, seed);
    await p.getByRole('button', { name: 'Strateji', exact: true }).click();
    const d = p.getByRole('dialog');
    assert.deepEqual(await dialogValues(d), { ...Object.fromEntries(categories.map(c => [c, 'unset'])), PTS: 'top3' });
    assert.equal(await d.getByText(/başlangıç önerisi/).count(), 0);
  });
}
