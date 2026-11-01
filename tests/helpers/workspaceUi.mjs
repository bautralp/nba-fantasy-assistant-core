/** Exercise recovery through a real, transient storage read failure. No production test hooks. */
export async function recovery(page) {
  if (await page.locator('.league-page').isVisible()) await page.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  if (!await page.getByLabel('JSON yedeği seç', { exact: true }).isVisible()) {
    if (!await page.getByRole('button', { name: 'Acil JSON kurtarma', exact: true }).isVisible()) {
      await page.evaluate(() => {
        const read = Storage.prototype.getItem;
        Storage.prototype.getItem = function(key) {
          if (key === 'nba-fantasy-assistant.session.v1') { Storage.prototype.getItem = read; throw new DOMException('Transient recovery test', 'SecurityError'); }
          return read.call(this, key);
        };
        dispatchEvent(new Event('focus'));
      });
    }
    await page.getByRole('button', { name: 'Acil JSON kurtarma', exact: true }).waitFor();
    if (!await page.getByLabel('JSON yedeği seç', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Acil JSON kurtarma', exact: true }).click();
    await page.getByRole('heading', { name: 'JSON yedekleme ve geri yükleme' }).waitFor();
  }
}
export async function settings(page) {
  const menu = page.locator('details.settings');
  if (await menu.count() && !await menu.evaluate(e => e.open)) await menu.locator('summary').click();
}
export async function importPool(page) {
  await settings(page);
  await page.getByRole('button', { name: 'Oyuncu havuzunu değiştir', exact: true }).click();
  if (!await page.locator('.import-review').first().isVisible()) await page.getByRole('button', { name: 'Oyuncu verilerini yükle', exact: true }).click();
}
export async function tab(page, name) {
  const target = page.getByRole('tab', { name, exact: true });
  await target.click();
  await page.waitForFunction(el => el.getAttribute('aria-selected') === 'true', await target.elementHandle());
}
export async function enterDraft(page) {
  await page.getByRole('heading', { name: 'NBA Fantasy Assistant', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).isVisible()) {
    await page.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).click();
    await page.getByRole('button', { name: 'Kendim yükleyeceğim', exact: false }).click();
  }
  await page.locator('#page-heading-draft').waitFor({state:'visible'});
}
/** Opens the league form from the first preparation step; new leagues pass through the ESPN dialog first. */
export async function openLeagueStep(page, scope = page) {
  await scope.locator('.setup-step').first().click();
  await page.locator('dialog[open], #setup-heading').first().waitFor();
  const manual = page.getByRole('dialog').getByRole('button', { name: 'Lig bilgilerini kendim gireceğim', exact: true });
  if (await manual.count()) await manual.click();
  await page.locator('#setup-heading').waitFor();
}
