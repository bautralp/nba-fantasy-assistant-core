import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
let server, base;
const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/espn/category-response-shape.json', import.meta.url), 'utf8'));
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
async function open(t, width = 375) {
 const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }); t.after(() => browser.close());
 const page = await browser.newPage({ viewport: { width, height: 1000 } }); const errors = [];
 page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
 await page.goto(base); await page.getByRole('button', { name: /Sezon İçi Asistanı Lig/ }).click(); return page;
}
async function connect(p, id = '789') { await p.getByLabel('ESPN League ID veya lig URL’si').fill(id); await p.getByRole('button', { name: 'Ligi bağla', exact: true }).click(); await p.getByRole('heading', { name: 'Synthetic category league' }).waitFor(); }
async function select(p, name = 'Synthetic A') { await p.getByRole('button', { name, exact: true }).click(); await p.getByRole('button', { name: 'Haftalık Eşleşmeler', exact: true }).waitFor(); }
async function back(p) { await p.getByRole('button', { name: '← Sezon içi ana menü', exact: true }).click(); }
const fits = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
for (const width of [320, 375]) test(`${width}px: card selection, all modules, keyboard, actual week, schedule, future empties, rosters and standings`, async t => {
 const p = await open(t, width), raw = fixture();
 raw.schedule[0].home.cumulativeScore.scoreByStat = { 0: { score: 83 }, 11: { score: 8 }, 19: { score: .48 }, 20: { score: .8 }, 2: { score: 7 } };
 raw.schedule[0].away.cumulativeScore.scoreByStat = { 0: { score: 80 }, 11: { score: 10 }, 19: { score: .50 }, 20: { score: .8 }, 2: { score: 7 } };
 raw.schedule.unshift({ ...structuredClone(raw.schedule[0]), matchupPeriodId: 2 });
 await p.route('https://lm-api-reads.fantasy.espn.com/**', async r => { assert.equal(r.request().headers().cookie, undefined); assert.ok(new URL(r.request().url()).searchParams.getAll('view').includes('mBoxscore')); await r.fulfill({ json: raw }); });
 await connect(p);
 assert.deepEqual(await p.locator('.team-selection button').allTextContents(), ['Synthetic A', 'Synthetic B']);
 assert.equal(await p.getByRole('combobox', { name: 'Benim takımım' }).count(), 0);
 await p.getByRole('button', { name: 'Synthetic A', exact: true }).focus(); await p.keyboard.press('Enter');
 await p.getByRole('button', { name: 'Haftalık Eşleşmeler', exact: true }).waitFor();
 assert.equal(await p.locator('.season-modules button').count(), 8); assert.equal(await p.locator('.season-modules button:disabled').count(), 0);
 assert.equal(await p.locator('.matchup-card, .season-roster').count(), 0); assert.equal(await fits(p), true);
 await p.getByRole('button', { name: 'Haftalık Eşleşmeler', exact: true }).click();
 assert.equal(await p.getByRole('status').textContent(), '4. hafta');
 assert.match(await p.locator('.matchup-card').innerText(), /5 \/ 2 \/ 2/);
 assert.match(await p.locator('.matchup-card').innerText(), /48%|48,0%/);
 assert.match(await p.locator('.matchup-card tr').filter({ hasText: 'TO' }).innerText(), /8.*Önde/s);
 assert.match(await p.locator('.matchup-card tr').filter({ hasText: 'FT%' }).innerText(), /Eşit/);
 assert.match(await p.locator('.matchup-card').innerText(), /Mevcut değil/);
 assert.equal(await p.locator('.matchup-card.is-mine').count(), 1); assert.equal(await fits(p), true);
 await back(p); await p.getByRole('button', { name: 'Fikstür', exact: true }).click();
 await p.getByRole('combobox', { name: 'Hafta', exact: true }).waitFor();
 assert.deepEqual(await p.getByRole('combobox', { name: 'Hafta', exact: true }).locator('option').allTextContents(), ['2. hafta', '4. hafta · Güncel', '5. hafta']);
 await p.getByRole('button', { name: '← Önceki hafta' }).click(); assert.equal(await p.getByRole('status').textContent(), '2. hafta'); assert.equal(await p.getByRole('button', { name: '← Önceki hafta' }).isDisabled(), true);
 await p.getByRole('button', { name: 'Sonraki hafta →' }).click(); await p.getByRole('button', { name: 'Sonraki hafta →' }).click();
 assert.equal(await p.getByRole('status').textContent(), '5. hafta');
 assert.doesNotMatch(await p.locator('.matchup-card').innerText(), /0 \/ 0 \/ 0|▲ Önde|Eşit/); assert.match(await p.locator('.matchup-card').innerText(), /Henüz oynanmadı/); assert.equal(await fits(p), true);
 await back(p); await p.getByRole('button', { name: 'Kadrolar', exact: true }).click();
 assert.match(await p.locator('.season-roster').innerText(), /Synthetic Player.*C/s); assert.doesNotMatch(await p.locator('.season-roster').innerText(), /901|ESPN|Bench|IR|UTIL/); assert.equal(await fits(p), true);
 await back(p); await p.getByRole('button', { name: 'Standings', exact: true }).click();
 const standings = await p.locator('.season-standings-table').innerText(); assert.match(standings, /Hesaplanan geçici sıralama/); assert.equal(await p.locator('.season-standings-table tr.is-mine').count(), 1); assert.equal(await fits(p), true);
 await p.getByRole('button', { name: 'Takım değiştir', exact: true }).click(); await select(p, 'Synthetic B');
 assert.equal(await p.evaluate(() => sessionStorage.getItem('nba-fantasy-assistant.espn-team.v1:789:2027')), '2');
});
test('reload restores connection preferences and scoped selection after reconnect; league and season isolation; refresh preserves screen and draft', async t => {
 const p = await open(t), raw = fixture(), draft = fresh(30), key = 'nba-fantasy-assistant.session.v1'; let fail = false;
 await p.evaluate(({ draft, key }) => sessionStorage.setItem(key, JSON.stringify(draft)), { draft, key });
 await p.route('https://lm-api-reads.fantasy.espn.com/**', async r => { const url = new URL(r.request().url()), data = structuredClone(raw); data.id = Number(url.pathname.split('/').at(-1)); data.seasonId = Number(url.pathname.split('/')[6]); await r.fulfill(fail ? { status: 403, json: {} } : { json: data }); });
 await connect(p); await select(p); await p.reload();
 assert.equal(await p.getByLabel('ESPN League ID veya lig URL’si').inputValue(), '789'); await connect(p); await p.locator('.season-modules').waitFor();
 await p.getByRole('button', { name: 'Kadrolar', exact: true }).click(); await p.waitForTimeout(2100); fail = true;
 await p.getByRole('button', { name: 'Verileri yenile' }).click(); await p.getByRole('alert').waitFor(); assert.match(await p.locator('.season-assistant').innerText(), /Eski veri/); assert.equal(await p.locator('.season-roster').count(), 1); fail = false;
 await p.getByRole('button', { name: 'Lig değiştir', exact: true }).click(); await p.waitForTimeout(2100); await connect(p, '456'); await p.locator('.team-selection').waitFor(); await select(p, 'Synthetic B');
 await p.getByRole('button', { name: 'Lig değiştir', exact: true }).click(); await p.getByLabel('Sezon (bitiş yılı)').fill('2026'); await p.waitForTimeout(2100); await connect(p); await p.locator('.team-selection').waitFor();
 assert.deepEqual(await p.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key), draft);
});
test('private response displays error; no league data or selection', async t => { const p = await open(t); await p.route('https://lm-api-reads.fantasy.espn.com/**', r => r.fulfill({ status: 401, json: {} })); await p.getByLabel('ESPN League ID veya lig URL’si').fill('789'); await p.getByRole('button', { name: 'Ligi bağla', exact: true }).click(); await p.getByRole('alert').waitFor(); assert.equal(await p.locator('.team-selection').count(), 0); });
test('changing league while refresh is pending cancels it and leaves the connection form usable', async t => {
 const p = await open(t); let count = 0, release;
 await p.route('https://lm-api-reads.fantasy.espn.com/**', async r => { count++; if (count === 2) await new Promise(resolve => { release = resolve; }); await r.fulfill({ json: fixture() }).catch(() => {}); });
 await connect(p); await select(p); await p.waitForTimeout(2100);
 await p.getByRole('button', { name: 'Verileri yenile' }).click(); await p.getByText('ESPN verileri okunuyor…', { exact: true }).waitFor();
 await p.getByRole('button', { name: 'Lig değiştir', exact: true }).click();
 assert.equal(await p.getByRole('button', { name: 'Ligi bağla', exact: true }).isEnabled(), true);
 release?.(); await p.waitForTimeout(2100); await connect(p); await p.locator('.season-modules').waitFor();
});
for (const width of [320, 375, 1024, 1280, 1920]) test(`${width}px: compact weekly and schedule matchups use responsive columns with paired teams`, async t => {
 const p = await open(t, width), raw = fixture();
 raw.teams.push({ id: 3, name: 'Synthetic C' }, { id: 4, name: 'Synthetic D' });
 const second = structuredClone(raw.schedule[0]); second.home.teamId = 3; second.away.teamId = 4; raw.schedule.push(second);
 await p.route('https://lm-api-reads.fantasy.espn.com/**', r => r.fulfill({ json: raw }));
 await connect(p); await select(p);
 for (const module of ['Haftalık Eşleşmeler', 'Fikstür']) {
  await p.getByRole('button', { name: module, exact: true }).click(); await p.locator('.matchup-card').nth(1).waitFor();
  const cards = await p.locator('.matchup-card').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom, width: r.width }; }));
  assert.equal(cards.length, 2); assert.ok(Math.abs(cards[0].width - cards[1].width) < 1);
  if (width >= 900) { assert.ok(cards[1].x > cards[0].x); assert.ok(Math.abs(cards[0].y - cards[1].y) < 1); }
  else { assert.ok(Math.abs(cards[0].x - cards[1].x) < 1); assert.ok(cards[1].y >= cards[0].bottom + 10); }
  assert.ok(cards[0].width <= 590); assert.ok(cards[0].bottom - cards[0].y < 440);
  const teams = await p.locator('.matchup-card').first().locator('.matchup-teams h4').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().x));
  assert.equal(teams.length, 2); assert.ok(teams[1] > teams[0]); assert.equal(await fits(p), true);
  await back(p);
 }
});
const categoryScenarios = [
 { name: '9CAT', type: 'H2H_MOST_CATEGORIES', ids: [0, 1, 2, 3, 6, 11, 17, 19, 20], rows: 9 },
 { name: '8CAT without turnovers', type: 'H2H_EACH_CATEGORY', ids: [0, 1, 2, 3, 6, 17, 19, 20], rows: 8 },
 { name: 'custom categories with unknown stat and reverse provider rule', type: 'H2H_MOST_CATEGORIES', ids: [999, 19, 21, 0], rows: 4 },
 { name: 'points with underlying stat scores', type: 'H2H_POINTS', ids: [0, 11, 19], rows: 0 },
 { name: 'unsupported scoring', type: 'UNKNOWN', ids: [0, 11, 19], rows: 0 },
 { name: 'roto is not a weekly H2H comparison', type: 'ROTO', ids: [0, 11, 19], rows: 0 },
 { name: '9CAT with missing scores and records', type: 'H2H_MOST_CATEGORIES', ids: [0, 1, 2, 3, 6, 11, 17, 19, 20], rows: 9, missing: true },
 { name: 'missing category configuration', type: 'H2H_MOST_CATEGORIES', ids: [], rows: 0 },
];
for (const scenario of categoryScenarios) test(`${scenario.name}: only provider-configured categories and verified records appear`, async t => {
 const p = await open(t), raw = fixture(); raw.settings.scoringSettings.scoringType = scenario.type;
 raw.settings.scoringSettings.scoringItems = scenario.ids.map(statId => ({ statId, points: 1, ...(statId === 0 && scenario.name.startsWith('custom') ? { isReverseItem: true } : {}) }));
 raw.teams[0].rankCalculatedFinal = 0; raw.teams[0].playoffSeed = 1; raw.teams[1].rankCalculatedFinal = 2; raw.teams[1].playoffSeed = 2;
 raw.teams[1].record = { overall: { wins: 3, losses: 0, ties: 0 } };
 for (const [side, values] of [['home', { 0: 80, 11: 8, 19: .48, 20: .8, 21: .375, 999: 33 }], ['away', { 0: 90, 11: 10, 19: .5, 20: .8, 21: .4, 999: 22 }]]) {
  const s = raw.schedule[0][side]; s.totalPoints = side === 'home' ? 123.5 : 0;
  if (scenario.missing) delete s.cumulativeScore;
  else s.cumulativeScore.scoreByStat = Object.fromEntries(Object.entries(values).map(([id, score]) => [id, { score }]));
 }
 await p.route('https://lm-api-reads.fantasy.espn.com/**', r => r.fulfill({ json: raw })); await connect(p); await select(p);
 for (const module of ['Haftalık Eşleşmeler', 'Fikstür']) {
  await p.getByRole('button', { name: module, exact: true }).click(); const card = p.locator('.matchup-card'); await card.waitFor();
  assert.equal(await card.locator('tbody tr').count(), scenario.rows);
  if (scenario.rows) {
   const labels = await card.locator('tbody th').evaluateAll(nodes => nodes.map(n => n.firstChild.textContent));
   const labelById = { 0: 'PTS', 1: 'BLK', 2: 'STL', 3: 'AST', 6: 'REB', 11: 'TO', 17: '3PM', 19: 'FG%', 20: 'FT%', 21: '3P%', 999: 'ESPN stat 999' };
   assert.deepEqual(labels, scenario.ids.map(id => labelById[id]));
   if (scenario.missing) { assert.equal(await card.locator('td').filter({ hasText: 'Mevcut değil' }).count(), 18); assert.equal(await card.locator('.category-leading').count(), 0); assert.match(await card.locator('.matchup-totals').innerText(), /Mevcut değil/); }
   else {
    assert.match(await card.getByRole('rowheader', { name: /^FG%/ }).locator('..').innerText(), /48,0%/);
    if (scenario.ids.includes(11)) assert.match(await card.getByRole('rowheader', { name: /^TO/ }).locator('..').locator('td').first().innerText(), /8.*Önde/s);
    if (scenario.name.startsWith('custom')) {
     assert.match(await card.getByRole('rowheader', { name: /^3P%/ }).locator('..').innerText(), /37,5%/);
     const unknown = card.getByRole('rowheader', { name: 'ESPN stat 999', exact: true }).locator('..');
     assert.equal(await unknown.locator('.category-leading').count(), 0); assert.match(await unknown.innerText(), /33/);
     assert.match(await card.getByRole('rowheader', { name: /^PTS/ }).locator('..').locator('td').first().innerText(), /80.*Önde/s);
    }
   }
  } else {
   assert.equal(await card.locator('.category-comparison').count(), 0);
   if (scenario.type === 'H2H_POINTS') assert.match(await card.innerText(), /Haftalık puan.*123,?\.?5/s);
   if (scenario.ids.length === 0) assert.match(await card.innerText(), /Kategori bilgisi mevcut değil/);
  }
  if (module === 'Fikstür') {
   await p.getByRole('button', { name: 'Sonraki hafta →' }).click(); await p.getByText('Henüz oynanmadı', { exact: true }).waitFor();
   assert.equal(await card.locator('tbody tr').count(), scenario.rows); assert.doesNotMatch(await card.locator('.matchup-totals').innerText(), /0 \/ 0 \/ 0|123\.5/);
   if (scenario.type === 'H2H_POINTS') assert.match(await card.innerText(), /Haftalık puan/);
  }
  assert.equal(await fits(p), true); await back(p);
 }
 await p.getByRole('button', { name: 'Standings', exact: true }).click(); await p.locator('.season-standings-table tbody tr').first().waitFor();
 assert.equal(await p.locator('.season-standings-table caption').count(), 1);
 const records = await p.locator('.season-standings-table tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].slice(2, 5).map(cell => cell.textContent)));
 assert.deepEqual(records, [['3', '0', '0'], ['3', '0', '0']]); assert.equal(await p.locator('.season-standings-table tr.is-mine').count(), 1);

});
