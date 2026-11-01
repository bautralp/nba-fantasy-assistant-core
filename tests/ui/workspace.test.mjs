import { enterDraft, recovery, settings, importPool, tab, openLeagueStep } from '../helpers/workspaceUi.mjs';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { migrateLegacyV3Json } from '../../src/infrastructure/persistence/legacyV3.ts';

const key = 'nba-fantasy-assistant.session.v1';
const legacyText = await readFile(new URL('../fixtures/persistence/v3-backup.json', import.meta.url), 'utf8');
const migrated = migrateLegacyV3Json(legacyText, { leagueId: 'integration', season: '2026-27', importedAt: '2026-10-20T12:00:00Z', confirmUnverifiableTurns: true });
assert.ok(migrated.ok);
const populated = { ...migrated.value.snapshot, manualDraftLocked: true, league: { ...migrated.value.snapshot.league, name: 'Integration league' } };
let server, browser, base;
before(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  await mkdir(new URL('../../artifacts/ui/', import.meta.url), { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(t, record, width = 1280, storageFailure) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
  t.after(() => context.close());
  if (record !== undefined) await context.addInitScript(({ key, record }) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem(key, record); sessionStorage.setItem('seeded', 'yes'); } }, { key, record });
  if (storageFailure) await context.addInitScript(failure => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'nba-fantasy-assistant.session.v1') throw new DOMException('Test storage error', failure);
      return original.call(this, key, value);
    };
  }, storageFailure);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(base); await enterDraft(page); await page.getByRole('heading', { name: 'NBA Fantasy Assistant', exact: true }).waitFor();
  await page.getByRole('status').filter({hasText:'Çalışma alanı yükleniyor'}).waitFor({state:'hidden'});
  await recovery(page);
  if (!record || record === '{broken') await openLeagueStep(page);
  await settings(page);
  return page;
}
async function fill(page) {
  await page.getByLabel('Lig adı', { exact: true }).fill('Test League');

  for (let i = 1; i <= 10; i++) await page.getByLabel(`Takım ${i} adı`, { exact: true }).fill(`Team ${i}`);
  await page.getByLabel('Kendi takımın', { exact: true }).selectOption({ label: 'Team 4' });
}
async function saved(page) { await page.getByRole('status').filter({ hasText: 'Çalışma alanı kaydedildi.' }).waitFor(); }
async function record(page) { return page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key); }
async function selectBackup(page, text) { await recovery(page);
  await page.getByLabel('JSON yedeği seç').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.getByText('Seçilen dosya: backup.json').waitFor();
}
async function previewNative(page, text) {
  await selectBackup(page, text); await page.getByRole('button', { name: 'Yedeği önizle' }).click();
}

test('first launch has a truly empty setup, required labels and no automatic persistence', async t => {
  const page = await open(t);
  assert.equal(await page.getByRole('heading', { name: 'Ligini oluştur' }).count(), 1);
  assert.equal(await page.getByLabel('Lig adı', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Sezon', { exact: true }).count(), 0);
  assert.match(await page.locator('.season-label').innerText(), /2026-27/);
  for (let i = 1; i <= 10; i++) assert.equal(await page.getByLabel(`Takım ${i} adı`, { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Kendi takımın', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click();
  await page.getByRole('alert').filter({ hasText: 'İşaretli alanları düzeltin' }).waitFor();
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 12);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
  assert.equal(await record(page), null);
});
test('duplicate names differing only by case are rejected beside both inputs', async t => {
  const page = await open(t); await fill(page); await page.getByLabel('Takım 2 adı', { exact: true }).fill('TEAM 1');
  await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click();
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 2); assert.equal(await record(page), null);
  assert.equal(await page.getByText('Takım adları farklı olmalı', { exact: false }).count(), 2);
});
test('creation, stable IDs on move, snake round reversal and reload persistence', async t => {
  const page = await open(t); await fill(page);
  const selected = await page.getByLabel('Kendi takımın', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Takım 4 yukarı taşı', exact: true }).click();
  assert.equal(await page.getByLabel('Kendi takımın', { exact: true }).inputValue(), selected);
  await page.getByRole('button', { name: 'Takım 4 yukarı taşı', exact: true }).click();
  await page.getByRole('button', { name: 'Takım 4 yukarı taşı', exact: true }).click();
  assert.equal(await page.getByLabel('Draft sıran').count(), 0);
  await page.getByText('Draft pozisyonun: 1', { exact: true }).waitFor();
  await page.getByText('İkinci tur sırasını gör').click();
  const firstRound = await page.locator('.team-row input').evaluateAll(inputs => inputs.map(input => input.value));
  assert.deepEqual(await page.locator('.round-preview li').allTextContents(), [...firstRound].reverse());
  await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click(); await saved(page);
  const snapshot = await record(page);
  assert.equal(snapshot.teams.length, 10); assert.equal(snapshot.league.userTeamId, selected); assert.equal(snapshot.draftSession.draftOrder[0], selected);
  assert.equal(snapshot.teams.find(team => team.id === selected).name, 'Team 4'); assert.deepEqual(snapshot.players, []);
  assert.ok(snapshot.strategies.every(strategy => Object.values(strategy.targets).every(target => target === 'unset')));
  await page.reload(); await page.getByRole('heading', { name: 'Test League', exact: true }).waitFor();
  assert.deepEqual(await record(page), snapshot); assert.equal(await page.getByRole('heading', { name: 'Ligini oluştur' }).count(), 0);
  await settings(page); await page.getByRole('button', { name: 'Lig bilgilerini düzenle', exact: true }).click();
  await page.getByLabel('Takım 4 adı', { exact: true }).fill('Updated team');
  await page.getByRole('button', { name: 'Takım 4 aşağı taşı', exact: true }).click();
  await page.getByRole('button', { name: 'Değişiklikleri kaydet' }).click(); await saved(page);
  const updated = await record(page); assert.equal(updated.league.userTeamId, selected); assert.equal(updated.draftSession.draftOrder[1], selected);
  assert.deepEqual(updated.teams.map(team => team.id), snapshot.teams.map(team => team.id));
});
test('editing a started draft locks order and preserves players, projections, ownership and targets', async t => {
  const page = await open(t, JSON.stringify(populated));
  await settings(page); await page.getByRole('button', { name: 'Lig bilgilerini düzenle', exact: true }).click();
  assert.equal(await page.getByLabel('Draft sıran').count(), 0);
  assert.equal(await page.locator('.move-buttons button:disabled').count(), 20);
  await page.getByText('Draft başladığı', { exact: false }).waitFor();
  await page.getByText('Takımını değiştirmek analiz odağını değiştirir', { exact: false }).waitFor();
  await page.getByLabel('Takım 1 adı', { exact: true }).fill('Renamed team');
  await page.getByLabel('Kendi takımın', { exact: true }).selectOption(populated.teams[9].id);
  await page.getByRole('button', { name: 'Değişiklikleri kaydet' }).click(); await saved(page);
  const updated = await record(page);
  for (const field of ['players', 'projections', 'datasets', 'eligibility', 'draftSession', 'strategies', 'rosterEntries']) assert.deepEqual(updated[field], populated[field]);
  assert.equal(updated.league.userTeamId, populated.teams[9].id); assert.equal(updated.teams[0].name, 'Renamed team');
});
for (const failure of ['QuotaExceededError', 'SecurityError']) test(`${failure} keeps the created workspace available for JSON recovery`, async t => {
  const page = await open(t, undefined, 375, failure); await fill(page);
  await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click();
  await page.getByRole('status').filter({ hasText: 'Kaydedilemedi.' }).waitFor();
  assert.equal(await record(page), null); await page.getByRole('heading', { name: 'Test League', exact: true }).waitFor();
  await recovery(page); const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'JSON yedeğini indir' }).click();
  const download = await downloadEvent; const json = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(json.league.name, 'Test League'); assert.equal(json.teams.length, 10);
});
test('corrupt storage is never reset or overwritten and memory remains recoverable', async t => {
  const page = await open(t, '{broken');
  await page.getByRole('alert').filter({ hasText: 'Otomatik silinmedi' }).waitFor();
  await fill(page); await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click();
  await page.getByRole('alert').filter({ hasText: 'üzerine yazılmadı' }).waitFor();
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), '{broken');
  await recovery(page); await page.getByRole('button', { name: 'JSON yedeğini indir' }).waitFor();
});
test('download and native restore require explicit replacement and explicit save; invalid restore is atomic', async t => {
  const page = await open(t, JSON.stringify(populated));
  await recovery(page); const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'JSON yedeğini indir' }).click();
  const download = await event; const backup = await readFile(await download.path(), 'utf8'); assert.deepEqual(JSON.parse(backup), populated);
  await page.getByLabel('JSON yedeği seç').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await page.getByRole('status').filter({ hasText: 'geçerli JSON değil' }).waitFor(); assert.deepEqual(await record(page), populated);
  await previewNative(page, JSON.stringify({ ...populated, teams: [] }));
  await page.getByRole('status').filter({ hasText: 'Veri doğrulanamadı' }).waitFor(); assert.deepEqual(await record(page), populated);
  const other = { ...populated, league: { ...populated.league, name: 'Restored league' } };
  await previewNative(page, JSON.stringify(other));
  assert.ok(await page.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).isDisabled());
  await recovery(page); await page.getByLabel('Mevcut çalışma alanının', { exact: false }).check();
  await page.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).click();
  await page.getByRole('heading', { name: 'Restored league', exact: true }).waitFor(); assert.deepEqual(await record(page), other);
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click(); await saved(page);
  assert.deepEqual(await record(page), other); await page.reload(); await page.getByRole('heading', { name: 'Restored league', exact: true }).waitFor();
});
test('v3 requires metadata and explicit consent for unverifiable picks and reports migration losses', async t => {
  const page = await open(t); await selectBackup(page, legacyText);
  await page.getByRole('button', { name: 'Yedeği önizle' }).click();
  await page.getByRole('status').filter({ hasText: 'lig adı ve sezon gerekli' }).waitFor();
  await page.getByLabel('Aktarılan lig adı').fill('Migrated league'); await page.getByLabel('Aktarılan sezon').fill('2026-27');
  await page.getByRole('button', { name: 'Yedeği önizle' }).click();
  await page.getByRole('heading', { name: 'Doğrulanamayan seçimler' }).waitFor();
  const confirm = page.getByRole('button', { name: 'Onayla ve aktarımı yeniden doğrula' }); assert.ok(await confirm.isDisabled());
  assert.ok(await page.getByText(/Seçim \d+:/).count() > 0); assert.equal(await record(page), null);
  await page.getByLabel('Bu seçimlerin mevcut sahipliğini').check(); await confirm.click();
  await page.getByRole('heading', { name: 'Aktarım bildirimleri ve sınırlar' }).waitFor();
  await page.getByText('ham değerler korunmadı', { exact: false }).first().waitFor();
  await page.getByText('Eski yükleme tarihi bilinmiyor; aktarım zamanı kullanıldı', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).click();
  await page.getByRole('heading', { name: 'Migrated league', exact: true }).waitFor(); assert.equal((await record(page)).league.name, 'Migrated league');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click(); await saved(page);
  const restored = await record(page); assert.equal(restored.league.name, 'Migrated league');
  assert.deepEqual(restored.draftSession.picks.map(pick => ({ player: restored.players.find(player => player.id === pick.playerId).providerIds.legacyV3, team: restored.teams.findIndex(team => team.id === pick.teamId) })), JSON.parse(legacyText).picks.map(pick => ({ player: pick.id, team: pick.team })));
  assert.ok(restored.draftSession.picks.some(pick => pick.outOfTurnConfirmed));
  assert.ok(Date.now() - Date.parse(restored.datasets[0].importedAt) < 60000);
});
for (const width of [280, 375, 1280]) test(`layout fits ${width}px in setup, errors, editor and import review`, async t => {
  const page = await open(t, undefined, width);
  const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`);
  await fits(); await page.screenshot({ path: `artifacts/ui/setup-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click(); await fits();
  await fill(page); await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).click(); await saved(page);
  await settings(page); await page.getByRole('button', { name: 'Lig bilgilerini düzenle', exact: true }).click(); await fits();
  await page.screenshot({ path: `artifacts/ui/workspace-${width}.png`, fullPage: true });
  await previewNative(page, JSON.stringify(populated)); await fits();
  await page.screenshot({ path: `artifacts/ui/import-${width}.png`, fullPage: true });
});

test('an older asynchronous file read cannot replace the newer selected backup', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function () {
      if (this.name === 'slow.json') await new Promise(resolve => { window.releaseSlowBackup = resolve; });
      return original.call(this);
    };
  });
  await recovery(page); await page.getByLabel('JSON yedeği seç').setInputFiles({ name: 'slow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...populated, league: { ...populated.league, name: 'Old file' } })) });
  await selectBackup(page, JSON.stringify(populated));
  await page.evaluate(() => window.releaseSlowBackup());
  await page.getByRole('button', { name: 'Yedeği önizle' }).click();
  await page.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).click();
  await page.getByRole('heading', { name: 'Integration league', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Old file', exact: true }).count(), 0);
  assert.equal((await record(page)).league.name, 'Integration league');
});
test('a workspace edit invalidates an old restore preview and requires fresh review', async t => {
  const page = await open(t, JSON.stringify(populated));
  await previewNative(page, JSON.stringify({ ...populated, league: { ...populated.league, name: 'Other backup' } }));
  await settings(page); await page.getByRole('button', { name: 'Lig bilgilerini düzenle', exact: true }).click();
  await page.getByLabel('Lig adı', { exact: true }).fill('Latest edit');
  await page.getByRole('button', { name: 'Değişiklikleri kaydet' }).click(); await saved(page);
  await recovery(page); await page.getByLabel('Mevcut çalışma alanının', { exact: false }).check();
  await page.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Yedeği yeniden önizleyip onaylayın' }).waitFor();
  assert.equal((await record(page)).league.name, 'Latest edit');
  await page.getByRole('heading', { name: 'Latest edit', exact: true }).waitFor();
});
test('keyboard can reorder a team, submit setup and return focus after cancelling edits', async t => {
  const page = await open(t, undefined, 375); await fill(page);
  const move = page.getByRole('button', { name: 'Takım 4 yukarı taşı', exact: true });
  await move.focus(); await page.keyboard.press('Enter');
  await page.getByText('Draft pozisyonun: 3', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Lig oluştur ve kaydet' }).focus(); await page.keyboard.press('Enter'); await saved(page);
  await settings(page); const edit = page.getByRole('button', { name: 'Lig bilgilerini düzenle', exact: true });
  await edit.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Vazgeç', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Lig bilgilerini düzenle');
});
