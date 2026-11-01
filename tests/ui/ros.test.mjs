import { unifiedScenario, unifiedStandard } from '../helpers/unifiedScenario.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { recovery } from '../helpers/workspaceUi.mjs';
import { selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { recordBrowserDiagnostics } from '../helpers/browserDiagnostics.mjs';
const key = 'nba-fantasy-assistant.session.v1';
const ros = unifiedStandard;
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; await mkdir('artifacts/ui/stage-14', { recursive: true }); });
after(async () => { await server?.close(); });
async function open(t, engine, width = 1280, preparation = false) {
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }); t.after(() => browser.close());
  const c = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR' });
  if (preparation) {
    const raw = fresh(0), w = { ...raw, datasets: [], league: { ...raw.league, season: '2026-27', activeDatasetId: null }, strategies: raw.strategies.map(s => ({ ...s, targets: { ...s.targets, PTS: 'top3' } })) };
    await c.addInitScript(({ key, w }) => { if (!sessionStorage.seeded) { sessionStorage.setItem(key, JSON.stringify(w)); sessionStorage.seeded = '1'; } }, { key, w });
  }
  const p = await c.newPage(); recordBrowserDiagnostics(t,p,browser,t.name); p.setDefaultTimeout(15000);
  const errors = []; p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await p.route('**/data/player-projections.json', r => r.fulfill({ json: unifiedStandard }));
  await p.route('**/data/projection-scenarios.json', r => r.fulfill({ json: unifiedScenario }));
  await p.goto(base); return p;
}
async function projected(p) {
  await p.getByRole('button', { name: 'Oyuncu Sıralamaları Oyuncu sıralamalarını', exact: false }).click();
  await p.getByLabel('Dönem', { exact: true }).selectOption('projected');
  await p.getByRole('region', { name: 'Projected oyuncu sıralamaları', exact: true }).getByRole('table').waitFor();
}
for (const engine of (process.env.BROWSER_ENGINES || 'chromium').split(',')) {
  test(`${engine}: StrictMode mounts issue one Actual and ROS data request without a cancelled probe`, async t => {
    const p = await open(t, engine);
    await p.evaluate(() => {
      const fetch = window.fetch.bind(window);
      window.rankingRequests = [];
      window.fetch = (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (/\/data\/player-(stats|projections)\.json$/.test(path)) window.rankingRequests.push(path);
        return fetch(input, init);
      };
    });
    await projected(p);
    const requests = await p.evaluate(() => window.rankingRequests);
    assert.equal(requests.filter(p => p.endsWith('/player-stats.json')).length, 1);
    assert.equal(requests.filter(p => p.endsWith('/player-projections.json')).length, 1);
  });
  test(`${engine}: missing rookie receives a unified projection while scientific model gate stays disabled`, async t => {
    const p=await open(t,engine);await projected(p);const section=p.getByRole('region',{name:'ROS projeksiyonları',exact:true});
    await section.getByLabel('Oyuncu adıyla ara').fill('AJ Dybantsa');assert.equal(await section.locator('tbody tr').count(),1);
    const completed=unifiedScenario.projection.players.find(r=>r.id==='5142718');assert.equal(completed.status,'available');assert.ok(completed.stats.PTS>0);
    const source=ros.players.find(r=>r.id==='5142718');assert.equal(source.team,'WSH');assert.equal(source.status,'unavailable');assert.equal(source.stats,null);assert.equal(ros.rookieModel.enabled,false);assert.equal(await section.locator('thead th').count(),20);
  });
  test(`${engine}: ROS rankings search, all columns sort, unavailable rows and failed refresh retain snapshot`, async t => {
    const p = await open(t, engine); await projected(p);
    const section = p.getByRole('region', { name: 'ROS projeksiyonları', exact: true });
    const table = section.getByRole('table');
    assert.equal(await table.locator('tbody tr').count(), Math.min(50,ros.players.filter(p=>p.status==='available').length));
    for (const button of await table.locator('thead button').all()) { await button.click(); await button.click(); }
    await section.getByLabel('Oyuncu adıyla ara').fill('Cade Cunningham');
    const row = table.locator('tbody tr'); assert.equal(await row.count(), 1);
    assert.match(await row.innerText(), /Unresolved|PG|SG|SF|PF|C/);
    assert.equal(await row.locator('td').count(),20);
    await section.getByLabel('Oyuncu adıyla ara').fill('');
    assert.doesNotMatch(await table.innerText(), /Projection unavailable/);
    const before = await table.innerText();
    await p.route('**/data/player-projections.json', r => r.fulfill({ status: 503 }));
    await section.locator('.table-help summary').click();
    await section.getByRole('button', { name: 'Projeksiyonu yeniden dene' }).click();
    await section.getByRole('alert').waitFor(); assert.equal(await table.innerText(), before);
    await p.getByLabel('Dönem', { exact: true }).selectOption('lastSeason');
    await p.getByRole('region', { name: 'SportsDataverse oyuncu istatistikleri', exact: true }).getByRole('table').waitFor();
  });
  test(`${engine}: changing an unlocked source selects the newly requested dataset without resetting league`, async t => {
    const p=await open(t,engine,1280,true);
    await p.getByRole('button',{name:'Draft Asistanı Ligini oluştur',exact:false}).click();
    const before=await p.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),key);
    await p.getByRole('button',{name:'Fantasy Assistant verilerini kullan',exact:false}).click();
    await p.getByRole('button',{name:'Oyuncu havuzunu yükle',exact:false}).click();
    const select=p.locator('section[aria-label="Merkezi draft kaynağı"] select');
    // The single Fantasy Assistant entry starts at ROS; Actual and the extended scenario stay selectable.
    assert.equal(await select.inputValue(),'projected');
    assert.deepEqual(await select.locator('option').evaluateAll(o=>o.map(e=>e.value)),['lastSeason','projected','extended']);
    await select.selectOption('lastSeason');assert.equal(await select.inputValue(),'lastSeason');
    assert.deepEqual(await p.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),key),before,'choosing a source does not change the league');
  });
  for (const [source, sourceSeason, gpMeaning, option] of [['2025-26 Actual — Last Season', '2025-26', 'observed-last-season', 'lastSeason'], ['2026-27 Projected — ROS', '2026-27', 'expected-remaining', null]]) {
    test(`${engine}: central ${source} needs no file, freezes identities/GP/positions and survives reload`, async t => {
      const p = await open(t, engine, 1280, true);
      await p.getByRole('button', { name: 'Draft Asistanı Ligini oluştur', exact: false }).click();
      await p.getByRole('heading',{name:'Veri kaynağını seç',exact:true}).waitFor();
      assert.equal(await p.locator('.source-cards button').count(), 2);
      await p.getByRole('button', { name: 'Fantasy Assistant verilerini kullan', exact: false }).click();
      await p.getByRole('button', { name: 'Oyuncu havuzunu yükle', exact: false }).click();
      if (option) await p.getByLabel('Veri kaynağı', { exact: true }).selectOption(option);
      assert.equal(await p.locator('input[type=file]:visible').count(), 0);
      await p.getByRole('button', { name: 'Merkezi kaynağı uygula' }).click();
      await p.getByRole('tab', { name: 'Draft', exact: true }).waitFor();
      await p.waitForFunction(key => JSON.parse(sessionStorage.getItem(key))?.manualDraftLocked, key);
      const snapshot = await p.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key);
      assert.equal(snapshot.league.season, '2026-27'); assert.equal(snapshot.datasets[0].provenance.sourceSeason, sourceSeason);
      assert.equal(snapshot.datasets[0].provenance.gpMeaning, gpMeaning);
      assert.ok(snapshot.players.length > 500);
      const ranking=selectDraftWorkspace(snapshot).poolRanking;
      assert.equal(ranking.source,sourceSeason==='2025-26'?'automatic':'provided');
      const expected=[...ranking.ranks].sort((a,b)=>a[1]-b[1]).map(([,rank])=>String(rank));
      if(sourceSeason==='2025-26') assert.deepEqual(expected,Array.from({length:ranking.ranks.size},(_,i)=>String(i+1)));
      else {
        for(const projection of snapshot.projections.filter(row=>row.status==='valid')) {
          const player=snapshot.players.find(player=>player.id===projection.playerId);
          assert.equal(ranking.ranks.get(player.id),ros.players.find(row=>row.id===player.providerIds.espn).rank);
        }
        assert.ok(expected.some((rank,i)=>i>0&&Number(rank)>Number(expected[i-1])+1),'ROS published gaps survive excluded players');
      }
      const pool=p.getByRole('region',{name:'Oyuncu istatistik tablosu',exact:true});
      const ranks=()=>pool.locator('tbody tr td:first-child').allTextContents();
      assert.equal(await p.getByLabel('Sıralama',{exact:true}).inputValue(),'RANK');
      assert.equal(await pool.locator('th').first().getAttribute('aria-sort'),'ascending');
      assert.deepEqual(await ranks(),expected.slice(0,50));
      assert.match(await p.locator('.pool-rank-info').innerText(),sourceSeason==='2025-26'?/Actual.*otomatik/:/ROS.*yayımlanmış kaynak/);
      await p.getByRole('button',{name:'Sonraki',exact:true}).click();assert.deepEqual(await ranks(),expected.slice(50,100));
      await p.getByRole('button',{name:'Önceki',exact:true}).click();assert.deepEqual(await ranks(),expected.slice(0,50));
      await recovery(p);
      const downloadPromise=p.waitForEvent('download');await p.getByRole('button',{name:'JSON yedeğini indir',exact:true}).click();
      const download=await downloadPromise,backup=await readFile(await download.path(),'utf8');assert.deepEqual(JSON.parse(backup),snapshot);
      await p.getByLabel('JSON yedeği seç',{exact:true}).setInputFiles({name:'central-backup.json',buffer:Buffer.from(backup)});
      await p.getByRole('button',{name:'Yedeği önizle',exact:true}).click();
      await p.getByLabel('Mevcut çalışma alanının',{exact:false}).check();
      await p.getByRole('button',{name:'Yedeği geri yükle',exact:true}).click();
      await pool.waitFor();assert.deepEqual(await ranks(),expected.slice(0,50));
      await p.getByRole('button',{name:'Sonraki',exact:true}).click();assert.deepEqual(await ranks(),expected.slice(50,100));
      await p.reload(); await p.getByRole('tab', { name: 'Draft', exact: true }).waitFor();
      assert.deepEqual(await p.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key), snapshot);
      assert.deepEqual(await ranks(),expected.slice(0,50));
      await p.getByRole('button', { name: 'Veri kaynağı seçimine dön' }).click();
      assert.ok(await p.getByRole('button', { name: 'Fantasy Assistant verilerini kullan', exact: false }).isDisabled());
    });
  }
 test(`${engine}: explicit Extended central Draft source preserves model labels and reloads without manual import`,async t=>{
   const p=await open(t,engine,375,true);
   await p.getByRole('button',{name:'Draft Asistanı Ligini oluştur',exact:false}).click();
   await p.getByRole('button',{name:'Fantasy Assistant verilerini kullan',exact:false}).click();
   await p.getByRole('button',{name:'Oyuncu havuzunu yükle',exact:false}).click();
   await p.getByLabel('Veri kaynağı',{exact:true}).selectOption('extended');
   await p.getByRole('button',{name:'Merkezi kaynağı uygula',exact:true}).click();
   await p.getByRole('tab',{name:'Draft',exact:true}).waitFor();
   const snapshot=await p.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),key);
   assert.equal(snapshot.datasets[0].provenance.projectionMode,'extended');
   const player=snapshot.players.find(r=>r.providerIds?.espn==='5142620');const row=snapshot.projections.find(r=>r.playerId===player.id);
   assert.equal(row.status,'valid');assert.match(row.presentation.modelLabel,/Düşük güven/);
   await p.getByLabel('Oyuncu ara',{exact:true}).fill('Darius Acuff');
   await p.getByRole('button',{name:'Darius Acuff Jr.',exact:true}).waitFor();
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await p.reload();await p.getByRole('tab',{name:'Draft',exact:true}).waitFor();
   const restored=await p.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),key);assert.deepEqual(restored,snapshot);
 });
}
if ((process.env.BROWSER_ENGINES || 'chromium').includes('chromium')) for (const width of [280, 375, 768, 1280, 1920]) test(`ROS mobile and desktop table at ${width}px`, async t => {
  const p = await open(t, 'chromium', width); await projected(p);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const region = p.getByRole('region', { name: 'Projected oyuncu sıralamaları', exact: true });
  await region.focus(); await p.keyboard.press('ArrowRight'); await region.evaluate(e => { e.scrollLeft = e.scrollWidth; });
  assert.ok(await region.evaluate(e => e.scrollWidth <= e.clientWidth || e.scrollLeft > 0));
  await region.evaluate(e => { e.scrollLeft = 0; }); await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `artifacts/ui/stage-14/projected-${width}.png` });


});
