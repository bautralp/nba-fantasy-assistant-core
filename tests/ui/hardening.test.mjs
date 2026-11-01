import { createWorkbook } from '../helpers/legacyWorkbook.ts';
import { enterDraft, recovery, settings, importPool, tab, openLeagueStep } from '../helpers/workspaceUi.mjs';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh as rawFresh } from '../helpers/draftFixture.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { selectDraftAnalysis } from '../../src/application/analysisSelectors.ts';
import { readWorkbook } from '../../src/infrastructure/projections/workbook.ts';
const fresh = (n) => { const w = { ...rawFresh(n), manualDraftLocked: true }; return applyDraftCommand(w, { kind: 'strategy', targets: {...w.strategies[0].targets, PTS:'top3'} }); };
const key = 'nba-fantasy-assistant.session.v1';
const engines = (process.env.BROWSER_ENGINES || 'chromium').split(',');
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; await mkdir('artifacts/ui/stage-10', { recursive: true }); await mkdir('artifacts/performance', { recursive: true }); });
after(async () => { await server?.close(); });
async function open(t, engine = 'chromium', w, width = 1280) {
  const browser = await ({chromium,firefox,webkit})[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR' });
  const p = await context.newPage(); p.setDefaultTimeout(10000);
  const errors = []; p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  const started=performance.now();
  await p.goto(base); await enterDraft(p); if (w) { await p.evaluate(({key,w}) => sessionStorage.setItem(key,JSON.stringify(w)), {key,w}); await p.reload(); }
  await p.getByRole('status').filter({hasText:'Çalışma alanı yükleniyor'}).waitFor({state:'hidden'}); await recovery(p); if (!w) await openLeagueStep(p); await settings(p); p.startupMs=performance.now()-started; return p;
}
async function backup(p) { await recovery(p); const event = p.waitForEvent('download'); await p.getByRole('button', {name:'JSON yedeğini indir',exact:true}).click(); return JSON.parse(await readFile(await (await event).path(),'utf8')); }
async function save(p) { await p.getByRole('button',{name:'Kaydet',exact:true}).click(); await p.getByRole('status').filter({hasText:'Çalışma alanı kaydedildi.'}).waitFor(); }
async function upload(p, rows, name='synthetic.xlsx', season='2026-27') {
  await p.getByLabel('Oyuncu projeksiyonu dosyası').setInputFiles({name,buffer:Buffer.from(createWorkbook(season,'perGame',rows))});
  await p.getByRole('heading',{name:'Projeksiyon önizlemesi',exact:true}).waitFor();
}
const cells = (n=600) => fresh(n).projections.map((r,i) => [r.playerId, `Fixture Player ${String(i).padStart(3,'0')}`, 'C', i+1, r.gamesPlayed, ...['FGM','FGA','FTM','FTA','3PM','PTS','REB','AST','STL','BLK','TO'].map(k=>r.stats[k])]);
const pool = p => p.getByRole('region',{name:'Oyuncu istatistik tablosu',exact:true});
async function player(p,i) { await tab(p,'Draft'); await p.getByLabel('Oyuncu ara',{exact:true}).fill(`Fixture Player ${String(i).padStart(3,'0')}`); return pool(p).getByRole('button',{name:`Fixture Player ${String(i).padStart(3,'0')}`,exact:true}); }
async function assign(p,i,team,action='Ata') {
  await (await player(p,i)).click(); const d=p.getByRole('dialog');
  if(team) await d.getByLabel('Atanacak takım').selectOption(team);
  const confirm=d.getByRole('checkbox'); if(await confirm.count()) await confirm.check();
  await d.getByRole('button',{name:action,exact:true}).click(); await d.waitFor({state:'hidden'});
}
async function compareAnalysis(p,w) {
  await tab(p,'Power Rankings'); const a=selectDraftAnalysis(w,selectDraftWorkspace(w));
  for(const c of a.categories) {
    const rows=p.getByRole('region',{name:`${c.cat} güç sıralaması`,exact:true}).locator('li');
    assert.deepEqual(await rows.evaluateAll(els=>els.map(e=>[e.dataset.teamId,e.querySelector('.power-rank').textContent,e.querySelector('.power-score').textContent])),c.leaders.map(t=>[t.teamId,`${t.rank}.`,t.score.toFixed(2)]));
  }
  await tab(p,'Draft'); const names=selectDraftWorkspace(w).topFive.map((r,i)=>`${i+1}. ${w.players.find(p=>p.id===r.playerId)?.name}`);
  assert.deepEqual(await p.locator('.recommendation-list .player-link').allTextContents(), names);
  await tab(p,'Takım Kadroları'); assert.equal(await p.locator('.team-roster').count(),10);
  assert.equal(await p.locator('.roster-player button').count(),w.draftSession.picks.length);
  assert.equal(await p.locator('.recommendation-list > li').count(), selectDraftWorkspace(w).topFive.length); await tab(p,'Draft');
}
for(const engine of engines) test(`${engine}: complete real draft, XLSX reload and JSON roundtrip journey`,async t=>{
  const p=await open(t,engine); const timings={startup:p.startupMs}; let start=performance.now();
  await p.getByLabel('Lig adı',{exact:true}).fill('Synthetic Draft');
  for(let i=1;i<=10;i++) await p.getByLabel(`Takım ${i} adı`,{exact:true}).fill(`Synthetic Team ${i}`);
  await p.getByLabel('Kendi takımın',{exact:true}).selectOption({label:'Synthetic Team 1'});
  await p.getByRole('button',{name:'Lig oluştur ve kaydet'}).click(); await p.getByRole('status').filter({hasText:'Çalışma alanı kaydedildi.'}).waitFor();
  const initial=await backup(p); assert.equal(initial.players.length,0);
  await importPool(p);
  const event=p.waitForEvent('download'); await p.getByRole('button',{name:'Boş Excel şablonunu indir'}).click(); const dl=await event;
  assert.equal(dl.suggestedFilename(),'nba-fantasy-projections.xlsx'); assert.equal(readWorkbook(new Uint8Array(await readFile(await dl.path())),dl.suggestedFilename()).rows.length,0);
  start=performance.now(); await upload(p,cells()); timings.xlsxPreview=performance.now()-start;
  await p.getByRole('button',{name:'Yüklemeyi uygula',exact:true}).click(); await p.locator('.setup-step').nth(1).click(); await p.getByRole('dialog').getByLabel('PTS',{exact:true}).selectOption('top3'); await p.getByRole('dialog').getByRole('button',{name:'Hedefleri uygula'}).click(); await p.locator('.pagination [role=status]').filter({hasText:'600 oyuncu'}).waitFor(); timings.importAndRender=performance.now()-start;
  await p.getByRole('button',{name:'Strateji',exact:true}).click(); const d=p.getByRole('dialog'); await d.getByLabel('PTS',{exact:true}).selectOption('top3'); await d.getByLabel('AST',{exact:true}).selectOption('top5'); await d.getByRole('button',{name:'Hedefleri uygula'}).click();
  const searchSamples=[];
  for(const sort of ['PTS','TOTAL Z','OYUNCU ADI']) { start=performance.now(); await p.getByLabel('Sıralama',{exact:true}).selectOption(sort); await p.getByLabel('Oyuncu ara',{exact:true}).fill('Player 599'); await pool(p).getByRole('button',{name:'Fixture Player 599'}).waitFor(); searchSamples.push(performance.now()-start); }
  timings.searchSortMax=Math.max(...searchSamples); await p.getByLabel('Sıralama',{exact:true}).selectOption('RANK');
  const pickTimes=[];
  for(let i=0;i<11;i++) { start=performance.now(); await assign(p,i); pickTimes.push(performance.now()-start); }
  timings.pickAndRenderMax=Math.max(...pickTimes);
  let w=await backup(p); assert.equal(w.draftSession.picks[9].teamId,w.draftSession.picks[10].teamId);
  await (await player(p,11)).click(); await p.getByRole('dialog').getByLabel('Atanacak takım').selectOption(w.teams[0].id);
  assert.ok(await p.getByRole('dialog').getByRole('button',{name:'Ata',exact:true}).isDisabled()); await p.getByRole('dialog').getByRole('checkbox').check(); await p.getByRole('dialog').getByRole('button',{name:'Ata',exact:true}).click();
  await assign(p,0,w.teams[1].id,'Takımını değiştir');
  await (await player(p,1)).click(); await p.getByRole('dialog').getByRole('button',{name:'Seçimi kaldır',exact:true}).click();
  await p.getByRole('button',{name:'Son seçimi geri al',exact:true}).click(); await p.getByRole('dialog').getByRole('button',{name:'Seçimi geri almayı onayla'}).click();
  w=await backup(p); await compareAnalysis(p,w);
  await settings(p); assert.ok(await p.getByRole('button',{name:'Oyuncu havuzunu değiştir',exact:true}).isDisabled());
  const updated=await backup(p); assert.deepEqual(updated,w);
  await save(p); await p.reload(); assert.deepEqual(await backup(p),updated);
  // Exercise a changed workspace before restoring the downloaded backup.
  await p.getByRole('button',{name:'Strateji',exact:true}).click(); await p.getByRole('dialog').getByLabel('PTS',{exact:true}).selectOption('punt'); await p.getByRole('dialog').getByRole('button',{name:'Hedefleri uygula'}).click();
  await recovery(p); start=performance.now(); await p.getByLabel('JSON yedeği seç',{exact:true}).setInputFiles({name:'roundtrip.json',buffer:Buffer.from(JSON.stringify(updated))}); await p.getByRole('button',{name:'Yedeği önizle',exact:true}).click();
  await p.getByLabel('Mevcut çalışma alanının',{exact:false}).check(); await p.getByRole('button',{name:'Yedeği geri yükle',exact:true}).click(); assert.deepEqual(await backup(p),updated); timings.jsonRestore=performance.now()-start;
  await compareAnalysis(p,updated);
  // Real keyboard modal trap, Escape, focus return, nested details and sticky cells.
  const opener=await player(p,0); await opener.focus(); await p.keyboard.press('Enter'); await p.getByRole('dialog').waitFor();
  const controls=p.getByRole('dialog').getByRole('button'); await controls.last().focus(); await p.keyboard.press('Tab'); assert.ok(await p.getByRole('dialog').getByRole('button',{name:'Pencereyi kapat'}).evaluate(b=>document.activeElement===b));
  await p.getByRole('dialog').getByRole('button',{name:'Pencereyi kapat'}).focus(); await p.keyboard.press('Shift+Tab'); assert.ok(await controls.last().evaluate(b=>document.activeElement===b));
  await p.keyboard.press('Escape'); assert.ok(await opener.evaluate(b=>document.activeElement===b));
  await p.getByLabel('Oyuncu ara',{exact:true}).fill('');
  const scroller=pool(p); await scroller.evaluate(e=>{e.scrollLeft=250;e.scrollTop=120;});
  const sticky=await p.locator('.player-table thead th').first().evaluate(e=>getComputedStyle(e).position); assert.equal(sticky,'sticky');
  assert.equal(await p.locator('.player-table tbody .player-name').first().evaluate(e=>getComputedStyle(e).position),'sticky');
  assert.equal(await p.getByLabel('Sıralama',{exact:true}).evaluate(e=>getComputedStyle(e).colorScheme),'light');
  await tab(p, 'Takım Kadroları'); const summary=p.locator('.team-roster summary').first(); await summary.focus(); await p.keyboard.press('Enter'); await p.keyboard.press('Enter');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); await save(p);
  await writeFile(`artifacts/performance/browser-${engine}.json`,JSON.stringify(timings,null,2));
});
if(engines.includes('chromium')) {
 test('stage 12: independent real tabs keep their own work and never modify old localStorage',async t=>{
  const a=await open(t,'chromium',fresh());
  await a.evaluate(()=>localStorage.setItem('nba-fantasy-assistant.workspace.v1','legacy-sentinel'));
  const b=await a.context().newPage();await b.goto(base);await enterDraft(b);
  // A fresh tab has its own session; no implicit localStorage migration.
  assert.equal(await b.getByRole('tab').count(),0);await openLeagueStep(b);assert.equal(await b.getByLabel('Lig adı',{exact:true}).inputValue(),'');
  await assign(a,0);assert.equal((await backup(a)).draftSession.picks.length,1);
  assert.equal(await b.evaluate(k=>sessionStorage.getItem(k),key),null);
  assert.equal(await a.evaluate(()=>localStorage.getItem('nba-fantasy-assistant.workspace.v1')),'legacy-sentinel');
 });
 test('beforeunload is active only for dirty work and clears after saving',async t=>{
  const p=await open(t,'chromium',fresh());
  const prevented=()=>p.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});dispatchEvent(e);return e.defaultPrevented;});
  assert.equal(await prevented(),false); await assign(p,0); assert.equal(await prevented(),false); await save(p); assert.equal(await prevented(),false);
 });
 for(const width of [280,375,768,1280,1920]) test(`light theme screenshots, scroll, modal and layout at ${width}px`,async t=>{
  const p=await open(t,'chromium',undefined,width); await p.screenshot({path:`artifacts/ui/stage-10/setup-${width}.png`,fullPage:true});
  let w=fresh(150); for(let i=0;i<35;i++) w=applyDraftCommand(w,{kind:'assign',playerId:`p${i}`,teamId:w.draftSession.draftOrder[Math.floor(i/10)%2?9-i%10:i%10]});
  w=applyDraftCommand(w,{kind:'strategy',targets:{...w.strategies[0].targets,PTS:'top3',AST:'top5'}});
  await p.evaluate(({key,w})=>sessionStorage.setItem(key,JSON.stringify(w)),{key,w}); await p.reload(); await p.getByRole('heading',{name:'Oyuncu havuzu',exact:true}).waitFor();
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await p.screenshot({path:`artifacts/ui/stage-10/workspace-${width}.png`,fullPage:true});
  for(const selector of ['.pool-panel','.recommendations-panel','section[aria-label="Category Power Rankings"]','section[aria-label="Takım kadroları"]','section[aria-label="Detaylı kategori ve rakip analizi"]']) { await tab(p, selector.includes('Power')?'Power Rankings':selector.includes('kadrolar')?'Takım Kadroları':selector.includes('Detaylı')?'Kategori / Rakip Analizi':'Draft'); const el=p.locator(selector); await el.screenshot({path:`artifacts/ui/stage-10/${selector.includes('pool')?'pool':selector.includes('recommendations')?'recommendations':selector.includes('Power')?'power':selector.includes('kadrolar')?'rosters':'analysis'}-${width}.png`}); }
  await (await player(p,0)).click(); const d=p.getByRole('dialog'); const r=await d.boundingBox(); assert.ok(r.x>=0 && r.y>=0 && r.x+r.width<=width+1 && r.y+r.height<=1001); await p.screenshot({path:`artifacts/ui/stage-10/modal-${width}.png`}); await p.keyboard.press('Escape');
  await settings(p); assert.ok(await p.getByRole('button',{name:'Oyuncu havuzunu değiştir',exact:true}).isDisabled());
  await assign(p,36); await p.screenshot({path:`artifacts/ui/stage-10/error-dirty-${width}.png`,fullPage:true}); assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 });
 test('200% browser zoom equivalent reflow retains controls and modal keyboard access',async t=>{
  const p=await open(t,'chromium',fresh(),640); // 1280px desktop at 200% has 640 CSS px.
  await p.evaluate(()=>document.documentElement.style.fontSize='28px');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await (await player(p,0)).click(); const box=await p.getByRole('dialog').boundingBox(); assert.ok(box.x>=0 && box.y>=0 && box.x+box.width<=640); await p.keyboard.press('Escape');
  await p.screenshot({path:'artifacts/ui/stage-10/zoom-200.png',fullPage:true});
 });
}
if(engines.includes('chromium')) test('native accessibility tree names form controls, reports errors and keeps untrusted text inert',async t=>{
 const w=fresh(); w.league.name='<img src=x onerror="globalThis.injected=true">';
 const p=await open(t,'chromium',w);
 const outbound=[]; p.on('request',r=>{if(!r.url().startsWith(base) && !r.url().startsWith('blob:')) outbound.push(r.url());});
 const cdp=await p.context().newCDPSession(p);
 async function auditNames(){ const {nodes}=await cdp.send('Accessibility.getFullAXTree'); const controls=nodes.filter(n=>!n.ignored && ['button','textbox','searchbox','combobox','checkbox','link','DisclosureTriangle'].includes(n.role?.value)); assert.ok(controls.length>10); for(const n of controls) assert.ok(n.name?.value?.trim(),`${n.role.value} must have a screen reader name`); }
 await auditNames(); assert.equal(await p.evaluate(()=>globalThis.injected),undefined); assert.equal(await p.locator('img').count(),0);
 await settings(p); await p.getByRole('button', { name: 'Lig bilgilerini düzenle', exact: true }).click(); await p.getByLabel('Lig adı',{exact:true}).fill('');
 await p.getByRole('button',{name:'Değişiklikleri kaydet',exact:true}).click();
 const invalid=p.locator('[aria-invalid="true"]'); assert.ok(await invalid.count()>0);
 await p.waitForFunction(()=>document.activeElement?.getAttribute('aria-invalid')==='true');
 for(const el of await invalid.all()) assert.ok(await el.evaluate(e=>Boolean(e.getAttribute('aria-describedby')?.split(/\s+/).every(id=>document.getElementById(id)?.textContent))));
 await auditNames(); assert.deepEqual(outbound,[]);
});

if (engines.includes('chromium')) test('failed first load in a second tab preserves unseen storage and JSON recovery until explicit reload', async t => {
  const existing = fresh();
  const a = await open(t, 'chromium', existing);
  const b = await a.context().newPage();
  b.setDefaultTimeout(10000);
  // Isolate only the browser storage failure; React, store and repository are real.
  await b.addInitScript(({storageKey,existing}) => {
    sessionStorage.setItem(storageKey,JSON.stringify(existing));
    globalThis.__blockWorkspaceRead = true;
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === storageKey && globalThis.__blockWorkspaceRead) throw new DOMException('Temporary test denial', 'SecurityError');
      return read.call(this, key);
    };
  }, {storageKey:key,existing});
  await b.goto(base); await enterDraft(b);
  await b.getByRole('alert').filter({ hasText: 'Tarayıcı kaydına erişilemiyor' }).waitFor();
  const original = await a.evaluate(k => sessionStorage.getItem(k), key);
  const working = fresh(150);
  await recovery(b); await b.getByLabel('JSON yedeği seç', { exact: true }).setInputFiles({ name: 'unsaved-synthetic.json', buffer: Buffer.from(JSON.stringify(working)) });
  await b.getByRole('button', { name: 'Yedeği önizle', exact: true }).click();
  await b.getByRole('button', { name: 'Yedeği geri yükle', exact: true }).click();
  assert.deepEqual(await backup(b), {...working,manualDraftLocked:true});
  await b.evaluate(() => { globalThis.__blockWorkspaceRead = false; });
  await b.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await b.getByRole('alert').filter({ hasText: 'Kayıt başka bir sekmede değişti' }).waitFor();
  assert.equal(await a.evaluate(k => sessionStorage.getItem(k), key), original);
  assert.deepEqual(await backup(b), {...working,manualDraftLocked:true});
  assert.ok(await b.getByRole('button', { name: 'Kaydet', exact: true }).isDisabled());
  const reload = b.getByRole('button', { name: 'Güncel tarayıcı kaydını yükle' });
  assert.ok(await reload.isDisabled());
  await b.getByLabel('Bellekteki çalışmamın', { exact: false }).check();
  await reload.click();
  await b.getByText('Güncel tarayıcı kaydı yüklendi.', { exact: false }).waitFor();
  assert.deepEqual(await backup(b), existing);
  // Explicit reload establishes the baseline; the next ordinary save succeeds.
  await assign(b, 0);
  await save(b);
  assert.equal((await b.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key)).draftSession.picks.length, 1);
  assert.equal((await a.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key)).draftSession.picks.length, 0);
});
