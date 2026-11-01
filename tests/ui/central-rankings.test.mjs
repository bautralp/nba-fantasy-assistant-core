import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { playerZScores } from '../../src/features/rankings/playerZScores.ts';
import { fresh } from '../helpers/draftFixture.ts';
const actual = JSON.parse(await readFile(new URL('../../public/data/player-stats.json', import.meta.url), 'utf8'));
const draftKey = 'nba-fantasy-assistant.session.v1';
const rankingsKey = 'nba-fantasy-assistant.rankings-session.v1';
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; await mkdir('artifacts/ui/stage-13', { recursive: true }); });
after(async () => { await server?.close(); });
async function open(t, width = 1280) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR' });
  const p = await context.newPage(); p.setDefaultTimeout(10000);
  const errors = []; p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await p.route('**/data/current-rosters.json', r => r.fulfill({status:404}));
  await p.goto(base); return p;
}
async function enter(p) {
  await p.getByRole('button', { name: 'Oyuncu Sıralamaları Oyuncu sıralamalarını', exact: false }).click();
}
const panel = p => p.locator('section').filter({ has: p.locator('#central-rankings-heading') });
const table = p => panel(p).getByRole('table');
// Deliberately synthetic edge-case fixture, never shipped in the production snapshot.
function fixture() {
  const v = structuredClone(actual);
  const player = (id, name, pts, fgm, fga) => {
    const p = structuredClone(v.periods.season.players[0]);
    return { ...p, id, name, gp: 2, totals: { ...p.totals, PTS: pts * 2, FGM: fgm * 2, FGA: fga * 2 }, stats: { ...p.stats, PTS: pts, FGM: fgm, FGA: fga, 'FG%': fga ? fgm / fga * 100 : null } };
  };
  v.periods.season.players = [player('1', 'Alpha Test', 30, 1, 2), player('2', 'Beta Test', 10, 0, 0)];
  v.periods.last7 = { ...v.periods.last7, players: [], dataThrough: null };
  return v;
}
test('real snapshot loads all periods, dates, per-game values and nine categories', async t => {
  const p = await open(t); await enter(p); await table(p).waitFor();
  for (const key of Object.keys(actual.periods)) {
    await panel(p).getByLabel('Dönem', { exact: true }).selectOption(key);
    assert.equal(await table(p).locator('tbody tr').count(), Math.min(50, actual.periods[key].players.length));
    assert.ok((await panel(p).innerText()).includes(actual.periods[key].dataThrough?.split('-').reverse().join('.') ?? '—'));
  }
  for (const c of ['RANK', 'TOTAL Z', 'GP', 'FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO']) assert.equal(await table(p).getByRole('button', { name: c, exact: true }).count(), 1);
  assert.ok(!(await panel(p).innerText()).includes('SportsDataverse · Gerçek NBA'));
  assert.match(await panel(p).innerText(), /Son güncelleme:/);
});
test('search, numeric sorting, percentage nulls last in both directions and empty calendar periods', async t => {
  const p = await open(t); await p.route('**/data/player-stats.json', route => route.fulfill({ json: fixture() }));
  await enter(p); await table(p).waitFor();
  assert.match(await table(p).locator('tbody tr').first().innerText(), /Alpha Test/);
  await table(p).getByRole('button', { name: 'PTS', exact: true }).click();
  assert.match(await table(p).locator('tbody tr').first().innerText(), /Beta Test/);
  await table(p).getByRole('button', { name: 'PTS', exact: true }).click();
  assert.match(await table(p).locator('tbody tr').first().innerText(), /Alpha Test/);
  for (let i = 0; i < 2; i++) {
    await table(p).getByRole('button', { name: 'FG%', exact: true }).click();
    assert.match(await table(p).locator('tbody tr').last().innerText(), /Beta Test/);
  }
  assert.match(await table(p).locator('tbody tr').first().innerText(), /50.0%/);
  await panel(p).getByLabel('Oyuncu adıyla ara').fill('beta'); assert.equal(await table(p).locator('tbody tr').count(), 1);
  await panel(p).getByLabel('Oyuncu adıyla ara').fill('nobody'); assert.equal(await table(p).locator('tbody tr').count(), 0);
  assert.match(await panel(p).innerText(), /eşleşen oyuncu bulunamadı/);
  await panel(p).getByLabel('Dönem', { exact: true }).selectOption('last7');
  assert.match(await panel(p).innerText(), /Bu takvim döneminde kaynağa kaydedilmiş maç bulunmuyor/);
});
test('HTTP, malformed JSON, invalid schema and network failures preserve displayed data and dates', async t => {
  const p = await open(t); await enter(p); await table(p).waitFor();
  // The positions catalog loads independently of the stats; snapshot the table only after every startup request has finished.
  await p.waitForLoadState('networkidle');
  const before = await table(p).innerText();
  for (const fail of [r => r.fulfill({ status: 503 }), r => r.fulfill({ body: 'not json', contentType: 'application/json' }), r => r.fulfill({ json: { schemaVersion: 2 } }), r => r.abort()]) {
    await p.route('**/data/player-stats.json', fail);
    if (!await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).isVisible()) await panel(p).locator('.table-help summary').click();
    await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).click();
    await panel(p).getByRole('alert').waitFor();
    assert.equal(await table(p).innerText(), before);
    assert.match(await panel(p).innerText(), new RegExp(actual.asOf.split('-').reverse().join('\\.')));
    await p.unroute('**/data/player-stats.json', fail);
  }
  if (!await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).isVisible()) await panel(p).locator('.table-help summary').click();
    await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).click();
  await p.waitForFunction(() => !document.querySelector('[aria-busy=true]'));
  assert.equal(await panel(p).getByRole('alert').count(), 0);
});
test('first-load error retries successfully; stale snapshots stay visible', async t => {
  const p = await open(t); const fail = r => r.fulfill({ status: 503 });
  await p.route('**/data/player-stats.json', fail); await enter(p); await panel(p).getByRole('alert').waitFor();
  assert.equal(await table(p).count(), 0); await p.unroute('**/data/player-stats.json', fail);
  const old = structuredClone(actual); old.refreshedAt = '2026-01-01T00:00:00+00:00';
  await p.route('**/data/player-stats.json', r => r.fulfill({ json: old }));
  if (!await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).isVisible()) await panel(p).locator('.table-help summary').click();
    await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).click(); await table(p).waitFor();
  assert.match(await panel(p).innerText(), /Güncelleme gecikmiş olabilir/);
  assert.ok(await table(p).locator('tbody tr').count() > 0);
});
test('central browsing and F5 preserve draft session and manual rankings; no provider calls in browser', async t => {
  const p = await open(t), w = fresh(30);
  await p.evaluate(({ draftKey, rankingsKey, w }) => { sessionStorage.setItem(draftKey, JSON.stringify(w)); sessionStorage.setItem(rankingsKey, 'manual-sentinel'); }, { draftKey, rankingsKey, w });
  const before = await p.evaluate(() => ({ ...sessionStorage }));
  const external = []; p.on('request', r => { if (!r.url().startsWith(base)) external.push(r.url()); });
  await enter(p); await table(p).waitFor(); await panel(p).getByLabel('Dönem', { exact: true }).selectOption('lastSeason');
  await p.reload(); await table(p).waitFor();
  const after = await p.evaluate(() => ({ ...sessionStorage }));
  assert.equal(after[draftKey], before[draftKey]); assert.equal(after[rankingsKey], before[rankingsKey]); assert.deepEqual(external, []);
  await p.getByRole('link', { name: 'NBA Fantasy Assistant', exact: true }).click();
  await p.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).click();
  await p.getByRole('button', { name: 'Mevcut çalışmaya devam et' }).click();
  assert.equal(await p.evaluate(k => sessionStorage.getItem(k), draftKey), before[draftKey]);
});
for (const width of [280, 375, 768, 1280, 1920]) test(`central statistics keyboard access and responsive table at ${width}px`, async t => {
  const p = await open(t, width); await enter(p); await table(p).waitFor();
  await p.waitForFunction(() => document.activeElement?.id === 'central-rankings-heading');
  await panel(p).getByLabel('Dönem', { exact: true }).focus(); await p.keyboard.press('ArrowDown');
  const region = panel(p).getByRole('region', { name: 'SportsDataverse oyuncu istatistikleri', exact: true });
  await region.focus(); await p.keyboard.press('ArrowRight');
  assert.equal(await table(p).getByRole('button', { name: 'TOTAL Z', exact: true }).count(), 1);
  await table(p).getByRole('button', { name: 'TOTAL Z', exact: true }).focus();
  await p.keyboard.press('Enter');
  await region.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  assert.ok(await region.evaluate(el => el.scrollWidth <= el.clientWidth || el.scrollLeft > 0));
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await p.screenshot({ path: `artifacts/ui/stage-13/rankings-${width}.png`, fullPage: true });
});

test('period ranks and totals survive search and every column sort; each period uses its own distribution', async t => {
  const snapshot = fixture();
  for (const [i, key] of Object.keys(snapshot.periods).entries()) {
    const a = structuredClone(snapshot.periods.season.players[0]);
    const b = structuredClone(snapshot.periods.season.players[1]);
    a.stats.PTS = i % 2 ? 1 : 40 + i;
    b.stats.PTS = i % 2 ? 40 + i : 1;
    snapshot.periods[key] = { ...snapshot.periods[key], dataThrough: snapshot.periods[key].to, players: [a, b] };
  }
  const p = await open(t);
  await p.route('**/data/player-stats.json', route => route.fulfill({ json: snapshot }));
  await enter(p); await table(p).waitFor();
  for (const key of Object.keys(snapshot.periods)) {
    await panel(p).getByLabel('Dönem', { exact: true }).selectOption(key);
    const expected = playerZScores(snapshot.periods[key].players).players;
    const verify = async () => {
      for (const row of expected) {
        const cells = table(p).locator('tbody tr').filter({ hasText: row.name }).locator('td');
        assert.equal(await cells.nth(0).innerText(), String(row.rank));
        assert.equal(await cells.nth(19).innerText(), row.totalZ.toFixed(2));
      }
    };
    await verify();
    for (const button of await table(p).locator('thead button').all()) { await button.click(); await verify(); await button.click(); await verify(); }
    const second = expected[1];
    await panel(p).getByLabel('Oyuncu adıyla ara').fill(second.name);
    assert.equal(await table(p).locator('tbody tr').count(), 1);
    assert.equal(await table(p).locator('tbody tr td').first().innerText(), '2');
    await panel(p).getByLabel('Oyuncu adıyla ara').fill('');
  }
});
test('default and TOTAL Z sorting preserve full precision even when displayed totals tie; refresh recomputes', async t => {
  const snapshot = fixture();
  const a = snapshot.periods.season.players[0], b = structuredClone(a), c = structuredClone(a);
  a.id = 'z'; a.name = 'Precision Winner'; a.stats.PTS = 20.000001;
  b.id = 'a'; b.name = 'Precision Runner'; b.stats.PTS = 20;
  c.id = 'b'; c.name = 'Precision Third'; c.stats.PTS = 1;
  snapshot.periods.season.players = [b, c, a];
  const p = await open(t);
  await p.route('**/data/player-stats.json', route => route.fulfill({ json: snapshot }));
  await enter(p); await table(p).waitFor();
  assert.equal(await table(p).getByRole('columnheader').filter({ hasText: 'TOTAL Z' }).getAttribute('aria-sort'), 'descending');
  const rows = table(p).locator('tbody tr');
  assert.match(await rows.nth(0).innerText(), /Precision Winner/);
  assert.equal(await rows.nth(0).locator('td').nth(19).innerText(), await rows.nth(1).locator('td').nth(19).innerText());
  await table(p).getByRole('button', { name: 'TOTAL Z', exact: true }).click();
  assert.match(await rows.last().innerText(), /Precision Winner/);
  await table(p).getByRole('button', { name: 'TOTAL Z', exact: true }).click();
  assert.match(await rows.first().innerText(), /Precision Winner/);
  a.stats.PTS = 0;
  if (!await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).isVisible()) await panel(p).locator('.table-help summary').click();
    await panel(p).getByRole('button', { name: 'Veriyi yeniden dene' }).click();
  await p.waitForFunction(() => !document.querySelector('[aria-busy=true]'));
  assert.match(await rows.first().innerText(), /Precision Runner/);
  assert.match(await panel(p).innerText(), /MPG: toplam dakika/);
});
