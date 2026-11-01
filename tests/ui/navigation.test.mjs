import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { settings } from '../helpers/workspaceUi.mjs';
const engines=(process.env.BROWSER_ENGINES||'chromium').split(',');
const key='nba-fantasy-assistant.session.v1',legacyKey='nba-fantasy-assistant.workspace.v1';
let server,base;
before(async()=>{server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();base=`http://127.0.0.1:${server.httpServer.address().port}`;await mkdir('artifacts/ui/stage-12',{recursive:true});});
after(async()=>{await server?.close();});
async function open(t,engine='chromium',width=1280,w){const browser=await({chromium,firefox,webkit})[engine].launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});t.after(()=>browser.close());const c=await browser.newContext({viewport:{width,height:1000},locale:'tr-TR'});await c.addInitScript(({key,legacyKey,w})=>{localStorage.setItem(legacyKey,'old-local-sentinel');if(w&&!sessionStorage.seeded){sessionStorage.setItem(key,JSON.stringify(w));sessionStorage.seeded='1';}},{key,legacyKey,w});const p=await c.newPage();p.setDefaultTimeout(10000);const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));await p.goto(base);return p;}
const section=(p,name)=>p.getByRole('button',{name,exact:false});
const central=p=>p.getByRole('button',{name:/Fantasy Assistant verilerini kullan/});
const home=p=>p.getByRole('link',{name:'NBA Fantasy Assistant',exact:true});
const names=['Oyuncu Sıralamaları Oyuncu sıralamalarını','Draft Asistanı Ligini oluştur','Sezon İçi Asistanı Lig, takım'];
for(const engine of engines){
 test(`${engine}: home has three accessible cards, each opens source choice and rankings central loads same-origin statistics`,async t=>{
  const p=await open(t,engine),requests=[];p.on('request',r=>{if(!r.url().startsWith(base)&&!r.url().startsWith('blob:'))requests.push(r.url());});assert.equal(await p.locator('.main-cards button').count(),3);assert.equal(await p.getByRole('tab').count(),0);assert.equal(await p.getByRole('heading',{name:'Draft için hazırlan'}).count(),0);
  // Rankings open the central data directly; Draft still asks for its data source.
  await section(p,names[0]).click();await p.getByRole('table').waitFor();assert.ok(await p.getByRole('table').locator('tbody tr').count()>0);assert.equal(await p.getByRole('heading',{name:'Veri kaynağını seç'}).count(),0);assert.equal(await p.getByRole('button',{name:'Veri kaynağı seçimine dön'}).count(),0);assert.equal(await p.getByLabel('Oyuncu dosyası').count(),0);await home(p).click();
  await section(p,names[1]).click();await p.getByRole('heading',{name:'Veri kaynağını seç'}).waitFor();assert.equal(await p.locator('.source-cards button').count(),2);await central(p).click();await p.getByRole('heading',{name:'Draft için hazırlan'}).waitFor();assert.equal(await p.getByRole('table').count(),0);assert.equal(await p.getByLabel('Oyuncu dosyası').isVisible(),false);await home(p).click();
  await p.getByRole('heading',{name:'Nasıl devam etmek istersin?'}).waitFor();assert.equal(await p.getByRole('button',{name:'Ana ekrana dön'}).count(),0);assert.equal(await home(p).getAttribute('aria-current'),'page');
  assert.deepEqual(requests,[]);assert.equal(await p.evaluate(k=>localStorage.getItem(k),legacyKey),'old-local-sentinel');
 });
 test(`${engine}: season opens ESPN form with keyboard navigation and no draft mutations`,async t=>{
  const p=await open(t,engine),requests=[]; p.on('request',r=>{if(r.url().includes('fantasy.espn.com'))requests.push(r.url());});
  await section(p,names[2]).focus();await p.keyboard.press('Enter');await p.getByRole('heading',{name:'Sezon İçi Asistanı',exact:true}).waitFor();
  await p.getByLabel('ESPN League ID veya lig URL’si').waitFor();assert.equal(await p.getByLabel('Sezon (bitiş yılı)').inputValue(),'2027');
  assert.equal(await p.locator('input[type=file]:visible').count(),0);assert.deepEqual(requests,[]);
  assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),key),null);await home(p).click();
 });
 test(`${engine}: rankings have no manual upload and older stored rankings navigation opens central data`,async t=>{
  const p=await open(t,engine);await p.evaluate(()=>sessionStorage.setItem('nba-fantasy-assistant.navigation.v1',JSON.stringify({page:'manual',section:'rankings'})));await p.reload();
  await p.getByRole('region',{name:'SportsDataverse oyuncu istatistikleri',exact:true}).getByRole('table').waitFor();assert.equal(await p.getByLabel('Oyuncu dosyası').count(),0);assert.equal(await p.getByRole('button',{name:/kendin yükle|Kendim yükleyeceğim/}).count(),0);
  // Leave only after the rankings data requests finish; WebKit reports a request cancelled by navigation as a page error.
  await p.waitForLoadState('networkidle');
  assert.equal(await home(p).getAttribute('aria-current'),null);await home(p).focus();await p.keyboard.press('Enter');await p.getByRole('heading',{name:'Nasıl devam etmek istersin?'}).waitFor();assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),key),null);
 });
 test(`${engine}: ready draft locks before first pick, home/source navigation preserves it, F5 preserves IDs and targets`,async t=>{
  const raw=fresh(30),w={...applyDraftCommand(raw,{kind:'strategy',targets:{...raw.strategies[0].targets,PTS:'top3'}}),manualDraftLocked:true};const p=await open(t,engine,1280,w);await section(p,names[1]).click();assert.ok(await central(p).isDisabled());await p.getByRole('button',{name:'Mevcut çalışmaya devam et'}).click();await settings(p);assert.ok(await p.getByRole('button',{name:'Oyuncu havuzunu değiştir',exact:true}).isDisabled());assert.equal(await p.getByLabel('Oyuncu projeksiyonu dosyası').count(),0);assert.equal(w.draftSession.picks.length,0);
  await p.getByRole('region',{name:'Oyuncu istatistik tablosu',exact:true}).getByRole('button',{name:'Fixture Player 000',exact:true}).click();await p.getByRole('dialog').getByRole('button',{name:'Ata',exact:true}).click();const before=await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),key);assert.equal(before.draftSession.picks.length,1);await p.getByRole('tab',{name:'Power Rankings',exact:true}).click();await p.reload();await p.getByRole('tab',{name:'Power Rankings',exact:true}).waitFor();assert.equal(await p.getByRole('tab',{name:'Power Rankings',exact:true}).getAttribute('aria-selected'),'true');await p.getByRole('tab',{name:'Draft',exact:true}).click();assert.deepEqual(await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),key),before);
  await home(p).click();await section(p,names[0]).click();await p.getByRole('region',{name:'SportsDataverse oyuncu istatistikleri',exact:true}).getByRole('table').waitFor();await home(p).click();await section(p,names[1]).click();await p.getByRole('button',{name:'Mevcut çalışmaya devam et'}).click();assert.deepEqual(await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),key),before);
  await p.getByRole('button',{name:'Yeni çalışma başlat',exact:true}).click();let d=p.getByRole('dialog');assert.ok(await d.getByRole('button',{name:'Yeni çalışmayı onayla'}).isDisabled());await d.getByRole('button',{name:'İptal',exact:true}).click();assert.deepEqual(await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),key),before);await p.getByRole('button',{name:'Yeni çalışma başlat',exact:true}).click();await d.getByRole('checkbox').check();await d.getByRole('button',{name:'Yeni çalışmayı onayla'}).click();await p.getByRole('heading',{name:'Nasıl devam etmek istersin?'}).waitFor();assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),key),null);assert.equal(await p.evaluate(k=>localStorage.getItem(k),legacyKey),'old-local-sentinel');
 });
}
if(engines.includes('chromium'))for(const width of [280,375,768,1280,1920])test(`stage 12 home, source and rankings fit ${width}px`,async t=>{
 const p=await open(t,'chromium',width),fits=async()=>assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await fits();await p.screenshot({path:`artifacts/ui/stage-12/home-${width}.png`,fullPage:true});const boxes=await p.locator('.main-card').evaluateAll(els=>els.slice(0,3).map(e=>e.getBoundingClientRect().y));if(width>=768)assert.equal(boxes[0],boxes[2]);else assert.ok(boxes[2]>boxes[0]);await section(p,names[1]).click();await fits();await p.screenshot({path:`artifacts/ui/stage-12/source-${width}.png`,fullPage:true});await home(p).click();await section(p,names[0]).click();const scroll=p.getByRole('region',{ name: 'SportsDataverse oyuncu istatistikleri', exact: true });await scroll.getByRole('table').waitFor();await fits();await p.screenshot({path:`artifacts/ui/stage-12/rankings-${width}.png`,fullPage:true});await scroll.focus();await p.keyboard.press('ArrowRight');await fits();
});
