import { createWorkbook } from '../helpers/legacyWorkbook.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';

import { enterDraft, recovery, settings, importPool, tab, openLeagueStep } from '../helpers/workspaceUi.mjs';
const key = 'nba-fantasy-assistant.session.v1';
const ready = () => {const w={...fresh(30),manualDraftLocked:true};return applyDraftCommand(w,{kind:'strategy',targets:{...w.strategies[0].targets,PTS:'top3'}});};
const picked = () => applyDraftCommand(ready(),{kind:'assign',playerId:'p0',teamId:'t0'});
let server, base;
before(async()=>{
 server=await createServer({server:{host:'127.0.0.1',port:0},plugins:[{name:'count-calculations',enforce:'pre',transform(code,id){if(id.endsWith('/src/engine/model.ts'))return code.replace('): CalculationModel {','): CalculationModel { globalThis.__modelCalls = (globalThis.__modelCalls ?? 0) + 1;');}}]});
 await server.listen();base=`http://127.0.0.1:${server.httpServer.address().port}`;
 await mkdir('artifacts/ui/stage-11',{recursive:true});
});
after(async()=>{await server?.close();});
async function open(t,engine,w,width=1280){
 const browser=await ({chromium,firefox,webkit})[engine].launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width,height:1000},locale:'tr-TR'});
 if(w)await context.addInitScript(({key,w})=>{if(!sessionStorage.seeded){sessionStorage.setItem(key,JSON.stringify(w));sessionStorage.seeded='1';}},{key,w});
 const p=await context.newPage();p.setDefaultTimeout(10000);const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await p.goto(base); await enterDraft(p);await p.getByRole('status').filter({hasText:'Çalışma alanı yükleniyor'}).waitFor({state:'hidden'});return p;
}
async function inspect(p){await recovery(p);const event=p.waitForEvent('download');await p.getByRole('button',{name:'JSON yedeğini indir',exact:true}).click();return JSON.parse(await readFile(await(await event).path(),'utf8'));}
async function confirmReset(p,name){await settings(p);await p.getByRole('button',{name,exact:true}).click();const d=p.getByRole('dialog');assert.ok(await d.getByRole('button',{name:'Sıfırlamayı onayla'}).isDisabled());await d.getByRole('checkbox').check();await d.getByRole('button',{name:'Sıfırlamayı onayla'}).click();await d.waitFor({state:'hidden'});}
for(const engine of (process.env.BROWSER_ENGINES||'chromium').split(',')){
 test(`${engine}: emergency JSON recovery is hidden normally and visible only for storage errors, conflicts or unreadable sessions`, async t => {
  const w = ready(), p = await open(t, engine, w);
  const trigger = p.getByRole('button', { name: 'Acil JSON kurtarma', exact: true });
  const file = p.getByLabel('JSON yedeği seç', { exact: true });
  await p.getByRole('tab', { name: 'Draft', exact: true }).waitFor();
  assert.equal(await trigger.isVisible(), false);
  assert.equal(await file.isVisible(), false);
  await p.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await p.getByRole('status').filter({ hasText: 'Çalışma alanı kaydedildi.' }).waitFor();
  assert.equal(await trigger.isVisible(), false);

  // A real read failure reveals the button; opening it still exposes the existing backup UI.
  await p.evaluate(key => {
   const read = Storage.prototype.getItem;
   Storage.prototype.getItem = function(k) {
    if (k === key) { Storage.prototype.getItem = read; throw new DOMException('Read denied', 'SecurityError'); }
    return read.call(this, k);
   };
   dispatchEvent(new Event('focus'));
  }, key);
  await trigger.waitFor();
  assert.equal(await file.isVisible(), false);
  await trigger.click(); await file.waitFor();
  assert.deepEqual(await inspect(p), w);

  // Successful retry hides the entire already-open recovery panel, not just its button.
  await p.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await p.getByRole('status').filter({ hasText: 'Çalışma alanı kaydedildi.' }).waitFor();
  await trigger.waitFor({ state: 'hidden' });
  assert.equal(await file.isVisible(), false);
  await p.evaluate(key => {
   const write = Storage.prototype.setItem;
   Storage.prototype.setItem = function(k, value) {
    if (k === key) { Storage.prototype.setItem = write; throw new DOMException('Quota full', 'QuotaExceededError'); }
    return write.call(this, k, value);
   };
  }, key);
  await p.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await p.getByRole('status').filter({ hasText: 'Kaydedilemedi.' }).waitFor();
  await trigger.waitFor(); assert.deepEqual(await inspect(p), w);
  await p.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await trigger.waitFor({ state: 'hidden' });

  await p.evaluate(({ key, w }) => {
   sessionStorage.setItem(key, JSON.stringify({ ...w, league: { ...w.league, name: 'External change' } }));
   dispatchEvent(new Event('focus'));
  }, { key, w });
  await p.getByText('Başka bir sekmede kayıt değişti.', { exact: false }).waitFor();
  await trigger.waitFor(); assert.deepEqual(await inspect(p), w);

  await p.evaluate(key => sessionStorage.setItem(key, '{broken'), key);
  await p.reload();
  await p.getByRole('alert').filter({ hasText: 'Otomatik silinmedi' }).waitFor();
  await trigger.waitFor();
  assert.equal(await p.evaluate(key => sessionStorage.getItem(key), key), '{broken');
 });
 test(`${engine}: preparation cards gate new Draft and preserve unset defaults until an active category is selected`,async t=>{
  const p=await open(t,engine);assert.equal(await p.locator('.setup-step').count(),3);assert.ok(await p.locator('.setup-step').nth(1).isDisabled());assert.ok(await p.locator('.setup-step').nth(2).isDisabled());
  await p.getByText('Strateji ve oyuncu yükleme için önce ligini oluşturmalısın',{exact:false}).waitFor();
  assert.equal(await p.getByRole('tab').count(),0);assert.equal(await p.getByRole('button',{name:'Acil JSON kurtarma'}).count(),0);assert.equal(await p.getByLabel('JSON yedeği seç').count(),0);assert.equal(await p.locator('a[href*="legacy"]').count(),0);
  await openLeagueStep(p);assert.equal(await p.getByLabel('Draft sıran').count(),0);
  await p.getByLabel('Lig adı',{exact:true}).fill('Yeni lig');for(let i=1;i<=10;i++)await p.getByLabel(`Takım ${i} adı`,{exact:true}).fill(`Takım ${i}`);
  await p.getByLabel('Kendi takımın',{exact:true}).selectOption({label:'Takım 4'});await p.getByText('Draft pozisyonun: 4',{exact:true}).waitFor();await p.getByRole('button',{name:'Takım 4 yukarı taşı',exact:true}).click();await p.getByText('Draft pozisyonun: 3',{exact:true}).waitFor();
  await p.getByRole('button',{name:'Lig oluştur ve kaydet'}).click();await p.getByRole('status').filter({hasText:'Çalışma alanı kaydedildi.'}).waitFor();
  assert.equal(await p.getByRole('tab').count(),0);assert.ok(await p.locator('.setup-step').nth(2).isEnabled());
  const w=await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),key);assert.ok(w.strategies.every(s=>Object.values(s.targets).every(v=>v==='unset')));assert.equal(w.draftSession.draftOrder.indexOf(w.league.userTeamId)+1,3);
  // Pool may be prepared before strategy.
  await p.locator('.setup-step').nth(2).click();await p.getByLabel('Oyuncu projeksiyonu dosyası').setInputFiles({name:'numeric.xlsx',buffer:Buffer.from(createWorkbook('2026-27','perGame',[[1,'Nikola Jokic','C',1,60,5,10,3,4,2,20,5,3,1,1,2],[2,'Player Two','G',2,60,5,10,3,4,2,18,5,3,1,1,2],[3,'Player Three','F',3,60,5,10,3,4,2,16,5,3,1,1,2]]))});
  await p.getByRole('heading',{name:'Projeksiyon önizlemesi',exact:true}).waitFor();await p.getByRole('button',{name:'Yüklemeyi uygula',exact:true}).click();assert.equal(await p.getByRole('tab').count(),0);
  await p.locator('.setup-step').nth(1).click();const d=p.getByRole('dialog');for(const c of ['FG%','FT%','3PM','PTS','REB','AST','STL','BLK','TO'])assert.equal(await d.getByLabel(c,{exact:true}).inputValue(),'top5','a team without targets starts from İlk 5 in the dialog');
  // Punt alone still does not complete the strategy: clear the UI suggestion explicitly first.
  for(const c of ['FG%','FT%','3PM','REB','AST','STL','BLK','TO'])await d.getByLabel(c,{exact:true}).selectOption('unset');await d.getByLabel('PTS',{exact:true}).selectOption('punt');await d.getByRole('button',{name:'Hedefleri uygula'}).click();assert.equal(await p.getByRole('tab').count(),0);
  await p.locator('.setup-step').nth(1).click();await d.getByLabel('PTS',{exact:true}).selectOption('top3');await d.getByRole('button',{name:'Hedefleri uygula'}).click();assert.equal(await p.getByRole('tab').count(),4);assert.equal(await p.getByRole('tab',{name:'Draft',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await p.getByRole('tabpanel').count(),1);assert.equal(await p.getByRole('heading',{name:'Draft için hazırlan'}).count(),0);
  const ids=(await inspect(p)).players.map(p=>p.id);assert.equal(new Set(ids).size,3);assert.ok(ids.every(id=>!['1','2','3'].includes(id)));
 });
 test(`${engine}: tabs preserve search, sorting, draft, strategy and workspace without recalculating engine`,async t=>{
  const w=picked(),p=await open(t,engine,w);await p.getByLabel('Oyuncu ara',{exact:true}).fill('Player 002');await p.getByLabel('Sıralama',{exact:true}).selectOption('PTS');const count=await p.evaluate(()=>globalThis.__modelCalls);assert.ok(count>0);
  for(const name of ['Power Rankings','Takım Kadroları','Kategori / Rakip Analizi','Draft']){await tab(p,name);assert.equal(await p.getByRole('tabpanel').count(),1);assert.equal(await p.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');}
  assert.equal(await p.getByLabel('Oyuncu ara',{exact:true}).inputValue(),'Player 002');assert.equal(await p.getByLabel('Sıralama',{exact:true}).inputValue(),'PTS');assert.equal(await p.evaluate(()=>globalThis.__modelCalls),count);assert.deepEqual(await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),key),w);assert.deepEqual(await inspect(p),w);
  await p.getByRole('tab',{name:'Draft',exact:true}).focus();await p.keyboard.press('End');assert.equal(await p.getByRole('tab',{name:'Kategori / Rakip Analizi',exact:true}).getAttribute('aria-selected'),'true');await p.keyboard.press('Home');assert.equal(await p.getByRole('tab',{name:'Draft',exact:true}).getAttribute('aria-selected'),'true');
 });
 test(`${engine}: stage 12 new work requires consent and strategy reset preserves locked draft and picks`,async t=>{
  const w=picked(),p=await open(t,engine,w);await p.getByRole('button',{name:'Yeni çalışma başlat',exact:true}).click();const d=p.getByRole('dialog');assert.ok(await d.getByRole('button',{name:'Yeni çalışmayı onayla'}).isDisabled());await d.getByRole('button',{name:'İptal',exact:true}).click();assert.deepEqual(await inspect(p),w);
  await confirmReset(p,'Stratejiyi sıfırla');assert.equal(await p.getByRole('tab').count(),4);let next=await inspect(p);assert.deepEqual(next.draftSession,w.draftSession);assert.deepEqual(next.strategies.filter(s=>s.teamId!=='t0'),w.strategies.filter(s=>s.teamId!=='t0'));assert.ok(Object.values(next.strategies.find(s=>s.teamId==='t0').targets).every(v=>v==='unset'));
  await settings(p);assert.ok(await p.getByRole('button',{name:'Oyuncu havuzunu değiştir',exact:true}).isDisabled());assert.equal(await p.getByRole('button',{name:'Oyuncu havuzunu sıfırla',exact:true}).count(),0);
  await tab(p,'Takım Kadroları');await p.locator('.team-roster[data-team-id="t0"]').getByRole('button',{name:'Fixture Player 000',exact:true}).click();await d.getByRole('button',{name:'Seçimi kaldır',exact:true}).waitFor();await p.keyboard.press('Escape');
  await p.getByRole('button',{name:'Yeni çalışma başlat',exact:true}).click();await d.getByRole('checkbox').check();await d.getByRole('button',{name:'Yeni çalışmayı onayla'}).click();await p.getByRole('heading',{name:'Nasıl devam etmek istersin?'}).waitFor();assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),key),null);
 });
 test(`${engine}: stage 12 legacy numeric IDs survive reload but cannot reimport into an active draft`,async t=>{
  const w=picked();w.players=w.players.map(p=>p.id==='p0'?{...p,name:'Nikola Jokic',providerIds:{projectionFile:'1'}}:p);const p=await open(t,engine,w);await settings(p);
  assert.ok(await p.getByRole('button',{name:'Oyuncu havuzunu değiştir',exact:true}).isDisabled());await p.reload();assert.deepEqual(await inspect(p),w);
 });
 test(`${engine}: failed session deletion retains memory; external mutation requires explicit reload`,async t=>{
  const w=picked(),p=await open(t,engine,w);await p.evaluate(()=>{Storage.prototype.removeItem=function(){throw new DOMException('Deletion denied','SecurityError');};});
  await p.getByRole('button',{name:'Yeni çalışma başlat',exact:true}).click();const d=p.getByRole('dialog');await d.getByRole('checkbox').check();await d.getByRole('button',{name:'Yeni çalışmayı onayla'}).click();await p.getByText('Lig silinemedi. Çalışmanız bellekte korunuyor.',{exact:false}).waitFor({state:'attached'});await d.getByRole('button',{name:'İptal',exact:true}).click();assert.deepEqual(await inspect(p),w);
  const latest={...w,league:{...w.league,name:'External change'}};await p.evaluate(({key,latest})=>{sessionStorage.setItem(key,JSON.stringify(latest));dispatchEvent(new Event('focus'));},{key,latest});await p.getByText('Başka bir sekmede kayıt değişti.',{exact:false}).waitFor();assert.deepEqual(await inspect(p),w);
 });
}
if(!process.env.BROWSER_ENGINES||process.env.BROWSER_ENGINES.includes('chromium'))for(const width of [280,375,768,1280,1920])test(`stage 11 setup and all four tabs fit ${width}px`,async t=>{
 const p=await open(t,'chromium',undefined,width);const fits=async()=>assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow at ${width}`);await fits();await p.screenshot({path:`artifacts/ui/stage-11/setup-${width}.png`,fullPage:true});
 const steps=await p.locator('.setup-step').evaluateAll(els=>els.map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y})));if(width>=768)assert.equal(steps[0].y,steps[2].y);else assert.ok(steps[2].y>steps[0].y);
 await p.evaluate(({key,w})=>sessionStorage.setItem(key,JSON.stringify(w)),{key,w:picked()});await p.reload();await p.getByRole('tab',{name:'Draft',exact:true}).waitFor();
 for(const [name,file]of [['Draft','draft'],['Power Rankings','power'],['Takım Kadroları','rosters'],['Kategori / Rakip Analizi','analysis']]){await tab(p,name);await fits();await p.screenshot({path:`artifacts/ui/stage-11/${file}-${width}.png`,fullPage:true});}
});
