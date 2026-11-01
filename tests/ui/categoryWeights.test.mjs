import { unifiedScenario, unifiedStandard } from '../helpers/unifiedScenario.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { playerZScores } from '../../src/features/rankings/playerZScores.ts';
import { applyWeights, DEFAULT_WEIGHTS, WEIGHTS_SESSION_KEY, rosZScores } from '../../src/features/rankings/categoryWeights.ts';

const engines = (process.env.BROWSER_ENGINES || 'chromium').split(',');
const actual = JSON.parse(await readFile(new URL('../../public/data/player-stats.json', import.meta.url), 'utf8'));
const ros = unifiedScenario.projection;
const punt = { ...DEFAULT_WEIGHTS, 'FT%': 0, TO: 0 };
const expectedActual = applyWeights(playerZScores(actual.periods.season.players).players, punt);
const expectedRos = applyWeights(rosZScores(ros), punt);
const publishedRosTop = ros.players.filter(p => p.status === 'available').sort((a, b) => a.rank - b.rank)[0];
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
async function open(t, engine, width) {
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const p = await (await browser.newContext({ viewport: { width, height: 900 }, locale: 'tr-TR' })).newPage(); p.setDefaultTimeout(10000);
  const errors = []; p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  // Keep zero-GP roster rows out so the first row is the rank-1 player.
  await p.route('**/data/current-rosters.json', r => r.fulfill({ status: 404 }));
  await p.route('**/data/player-projections.json', r => r.fulfill({ json: unifiedStandard }));
  await p.route('**/data/projection-scenarios.json', r => r.fulfill({ json: unifiedScenario }));
  await p.goto(base);
  await p.getByRole('button', { name: 'Oyuncu Sıralamaları Oyuncu', exact: false }).click();
  // Works with or without the separate rankings source page.
  await p.locator('.source-cards, .central-panel').first().waitFor();
  if (await p.locator('.source-cards').isVisible()) await p.getByRole('button', { name: 'Fantasy Assistant verilerini kullan', exact: false }).click();
  return p;
}
const region = (p, name) => p.getByRole('region', { name, exact: true });
const firstRow = async (p, name) => (await region(p, name).locator('tbody tr').first().locator('td').allInnerTexts()).map(s => s.trim());
const fits = async p => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

for (const engine of engines) for (const width of engine === 'chromium' ? [375, 1280] : [375]) test(`${engine}: category weights re-rank Actual and ROS, persist in the session and reset at ${width}px`, async t => {
  const p = await open(t, engine, width);
  const actualName = 'SportsDataverse oyuncu istatistikleri', rosName = 'Projected oyuncu sıralamaları';
  await region(p, actualName).locator('tbody tr').first().waitFor();
  const panel = p.locator('details.category-weights');
  assert.equal(await panel.evaluate(e => e.open), false, 'collapsed by default');
  assert.match(await panel.locator('summary').innerText(), /Tümü 1 \(varsayılan\)/);
  if (width <= 400) assert.ok((await panel.boundingBox()).height < 70, 'collapsed panel stays compact on phones');
  await fits(p);
  const defaultTop = await firstRow(p, actualName);
  assert.equal(defaultTop[0], '1');

  await panel.locator('summary').click();
  assert.equal(await p.getByLabel('PTS katsayısı', { exact: true }).inputValue(), '1');
  assert.deepEqual(await p.getByLabel('PTS katsayısı', { exact: true }).locator('option').allInnerTexts(), ['0 (punt)', '0,25', '0,5', '1', '1,5', '2', '3']);
  assert.ok(await panel.getByRole('button', { name: 'Sıfırla', exact: true }).isDisabled());
  await p.getByLabel('FT% katsayısı', { exact: true }).selectOption('0');
  await p.getByLabel('TO katsayısı', { exact: true }).selectOption('0');
  await fits(p);
  assert.match(await p.locator('.weighted-note').innerText(), /FT% ×0 · TO ×0/);
  const weightedTop = await firstRow(p, actualName);
  assert.equal(weightedTop[0], '1');
  assert.equal(weightedTop[1], expectedActual[0].name);
  assert.equal(weightedTop.at(-1), expectedActual[0].totalZ.toFixed(2));

  await p.reload();
  await region(p, actualName).locator('tbody tr').first().waitFor();
  assert.equal(await p.getByLabel('FT% katsayısı', { exact: true }).inputValue(), '0', 'kept after reload in the same session');
  assert.deepEqual(await firstRow(p, actualName), weightedTop);

  await p.getByLabel('Dönem', { exact: true }).selectOption('projected');
  await region(p, rosName).locator('tbody tr').first().waitFor();
  const rosTop = await firstRow(p, rosName);
  assert.equal(rosTop[1], expectedRos[0].name);
  assert.equal(rosTop.at(-1), expectedRos[0].totalZ.toFixed(2));

  if (!await panel.evaluate(e => e.open)) await panel.locator('summary').click();
  await panel.getByRole('button', { name: 'Sıfırla', exact: true }).click();
  assert.equal(await p.locator('.weighted-note').count(), 0);
  assert.equal(await p.evaluate(k => sessionStorage.getItem(k), WEIGHTS_SESSION_KEY), null);
  const resetRos = await firstRow(p, rosName);
  assert.equal(resetRos[1], publishedRosTop.name);
  assert.equal(resetRos.at(-1), publishedRosTop.totalZ.toFixed(2));
  await p.getByLabel('Dönem', { exact: true }).selectOption('season');
  assert.deepEqual(await firstRow(p, actualName), defaultTop);
  await fits(p);
  if (process.env.WEIGHTS_CAPTURE_DIR) await p.screenshot({ path: `${process.env.WEIGHTS_CAPTURE_DIR}/weights-${engine}-${width}.png` });
});
