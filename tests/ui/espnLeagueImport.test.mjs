import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { espnLeague, DEFAULT_PICK_ORDER } from '../helpers/espnLeagueFixture.ts';

const engines = (process.env.BROWSER_ENGINES || 'chromium').split(',');
const key = 'nba-fantasy-assistant.session.v1';
const ESPN = 'https://lm-api-reads.fantasy.espn.com/**';
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
async function open(t, engine, width, respond) {
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const p = await (await browser.newContext({ viewport: { width, height: 900 }, locale: 'tr-TR' })).newPage(); p.setDefaultTimeout(10000);
  const errors = []; p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  const requests = [];
  await p.route(ESPN, async route => { requests.push({ url: route.request().url(), method: route.request().method() }); await respond(route); });
  await p.goto(base);
  await p.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).click();
  await p.getByRole('button', { name: 'Kendim yükleyeceğim', exact: false }).click();
  await p.locator('#page-heading-draft').waitFor({ state: 'visible' });
  await p.locator('.setup-step').first().click();
  return { p, requests, dialog: p.getByRole('dialog') };
}
const json = (body, status = 200) => route => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
const fetchLeague = async (dialog, id = '123') => { await dialog.getByLabel('ESPN lig ID’si', { exact: true }).fill(id); await dialog.getByRole('button', { name: 'Ligi ESPN’den getir', exact: true }).click(); };
const fits = async p => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
const capture = async (p, name) => { if (process.env.ESPN_CAPTURE_DIR) { await p.waitForTimeout(700); await p.screenshot({ path: `${process.env.ESPN_CAPTURE_DIR}/${name}.png` }); } };

for (const engine of engines) for (const width of engine === 'chromium' ? [375, 1280] : [375]) {
  test(`${engine}: supported ESPN league fills the form; the user still picks their team (${width}px)`, async t => {
    const { p, requests, dialog } = await open(t, engine, width, json(espnLeague()));
    await dialog.getByText(/Şimdilik yalnız 10 takımlı, takım başına 13 oyunculu ve 9 kategorili ESPN ligleri/).waitFor();
    assert.ok(await dialog.getByRole('button', { name: 'Ligi ESPN’den getir', exact: true }).isDisabled(), 'empty ID cannot be submitted');
    await fits(p); await capture(p, `espn-dialog-${engine}-${width}`);
    await fetchLeague(dialog);
    await p.locator('#setup-heading').waitFor();
    assert.equal(await p.getByRole('dialog').count(), 0);
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'GET');
    assert.match(requests[0].url, /seasons\/2027\/segments\/0\/leagues\/123\?/);
    await p.getByRole('status').filter({ hasText: 'ESPN’den aktarıldı: Fixture ESPN League · 10 takım' }).waitFor();
    assert.equal(await p.getByLabel('Lig adı', { exact: true }).inputValue(), 'Fixture ESPN League');
    for (let i = 1; i <= 10; i++) assert.equal(await p.getByLabel(`Takım ${i} adı`, { exact: true }).inputValue(), `ESPN Takım ${i}`);
    assert.equal(await p.getByLabel('Kendi takımın', { exact: true }).inputValue(), '');
    await p.getByRole('status').filter({ hasText: 'Draft sırası ESPN’den aktarıldı' }).waitFor();
    const orderedNames = await p.locator('.team-list .team-row input').evaluateAll(inputs => inputs.map(i => i.value));
    assert.deepEqual(orderedNames, DEFAULT_PICK_ORDER.map(id => `ESPN Takım ${id}`), 'first-round order follows ESPN');
    await fits(p); await capture(p, `espn-form-${engine}-${width}`);
    await p.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click();
    await p.getByText('İşaretli alanları düzeltin. Kayıt yapılmadı.').waitFor();
    assert.equal(await p.evaluate(k => sessionStorage.getItem(k), key), null, 'nothing is created before choosing a team');
    await p.getByLabel('Kendi takımın', { exact: true }).selectOption({ label: 'ESPN Takım 4' });
    await p.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click();
    await p.getByRole('status').filter({ hasText: 'Çalışma alanı kaydedildi.' }).waitFor();
    const saved = await p.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key);
    assert.equal(saved.league.name, 'Fixture ESPN League'); assert.equal(saved.league.season, '2026-27');
    assert.equal(saved.teams.find(team => team.id === saved.league.userTeamId).name, 'ESPN Takım 4');
    assert.deepEqual(saved.draftSession.draftOrder.map(id => saved.teams.find(team => team.id === id).name), DEFAULT_PICK_ORDER.map(id => `ESPN Takım ${id}`));
    assert.equal(requests.length, 1, 'no further ESPN requests');
  });

  test(`${engine}: a league without an ESPN draft order keeps team order and says so (${width}px)`, async t => {
    const { p, dialog } = await open(t, engine, width, json(espnLeague({ draft: null })));
    await fetchLeague(dialog);
    await p.getByRole('status').filter({ hasText: 'draft sırası henüz belirlenmemiş' }).waitFor();
    const orderedNames = await p.locator('.team-list .team-row input').evaluateAll(inputs => inputs.map(i => i.value));
    assert.deepEqual(orderedNames, Array.from({ length: 10 }, (_, i) => `ESPN Takım ${i + 1}`));
  });

  test(`${engine}: unsupported league explains the mismatch and switches to manual entry in one click (${width}px)`, async t => {
    const { p, dialog } = await open(t, engine, width, json(espnLeague({ teams: 12, name: 'Büyük Lig' })));
    await fetchLeague(dialog);
    const alert = dialog.getByRole('alert');
    await alert.getByText('“Büyük Lig” bu ayarlarla otomatik aktarılamıyor:').waitFor();
    assert.match(await alert.innerText(), /Ligin 12 takımlı/);
    await fits(p); await capture(p, `espn-unsupported-${engine}-${width}`);
    await alert.getByRole('button', { name: 'Lig bilgilerini kendim gireceğim', exact: true }).click();
    await p.locator('#setup-heading').waitFor();
    assert.equal(await p.getByLabel('Lig adı', { exact: true }).inputValue(), '');
    assert.equal(await p.getByLabel('Takım 1 adı', { exact: true }).inputValue(), '');
    assert.equal(await p.evaluate(k => sessionStorage.getItem(k), key), null);
  });
}

for (const engine of engines) test(`${engine}: not found, private, unreachable and invalid IDs show distinct messages`, async t => {
  let mode = 'missing';
  const { p, requests, dialog } = await open(t, engine, 375, async route => {
    if (mode === 'missing') return json({ messages: ['not found'] }, 404)(route);
    if (mode === 'private') return json({ messages: ['private'] }, 401)(route);
    if (mode === 'flagged') return json(espnLeague({ isPublic: false }))(route);
    return route.abort('internetdisconnected');
  });
  const message = async () => (await dialog.getByRole('alert').innerText());
  await fetchLeague(dialog); await dialog.getByRole('alert').waitFor();
  assert.match(await message(), /bulunamadı/);
  for (const [next, pattern] of [['private', /gizli \(private\)/], ['flagged', /gizli \(private\)/], ['offline', /ulaşılamadı/]]) {
    mode = next; await p.waitForTimeout(2100); // the client enforces a 2 s gap between ESPN requests
    await fetchLeague(dialog); await dialog.getByRole('alert').filter({ hasText: pattern }).waitFor();
  }
  const count = requests.length;
  await fetchLeague(dialog, 'abc');
  await dialog.getByRole('alert').filter({ hasText: /Lig ID’si geçersiz/ }).waitFor();
  assert.equal(requests.length, count, 'an invalid ID is rejected before any request');
  await dialog.getByRole('button', { name: 'Lig bilgilerini kendim gireceğim', exact: true }).click();
  await p.locator('#setup-heading').waitFor();
  assert.ok(requests.every(r => r.method === 'GET'));
});
