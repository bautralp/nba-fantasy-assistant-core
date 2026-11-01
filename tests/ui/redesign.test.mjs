import { unifiedScenario, unifiedStandard } from '../helpers/unifiedScenario.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { PLAYER_COLUMNS } from '../../src/shared/playerTableModel.ts';
import { recordBrowserDiagnostics } from '../helpers/browserDiagnostics.mjs';
const rosterFixture = JSON.parse(await readFile('public/data/current-rosters.json','utf8'));
const engines = (process.env.BROWSER_ENGINES || 'chromium').split(',');
let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; await mkdir('artifacts/ui/stage-15', { recursive: true }); });
after(async () => server?.close());
async function open(t, engine, width, workspace) {
 const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }); t.after(() => browser.close());
 const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR' });
 if (workspace) await context.addInitScript(w => { sessionStorage.setItem('nba-fantasy-assistant.session.v1', JSON.stringify(w)); }, workspace);
 const p = await context.newPage(); recordBrowserDiagnostics(t,p,browser,`${engine}-redesign-${width}`); p.setDefaultTimeout(6000); const errors=[]; p.on('pageerror', e=>errors.push(e.message)); t.after(()=>assert.deepEqual(errors,[])); await p.clock.setFixedTime(new Date(rosterFixture.retrievedAt)); await p.route('**/data/player-projections.json', r => r.fulfill({ json: unifiedStandard }));
  await p.route('**/data/projection-scenarios.json', r => r.fulfill({ json: unifiedScenario }));
  await p.goto(base); return p;
}
async function fits(p) { assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'page must not overflow'); }
async function verifyTable(p, label, width) {
 // Projected ROS fetches and ranks its data only when first opened; allow the same first-load wait as ros.test.mjs (15 s).
 const scroll = p.getByRole('region', { name: label, exact: true }), table=scroll.locator('table'); await table.waitFor({ timeout: 15000 });
 assert.deepEqual(await table.locator('thead button').allTextContents(), [...PLAYER_COLUMNS]);
 assert.ok(await table.locator('tbody tr').count() <= 50);
 const frame=scroll.locator('..'), top=frame.locator('.top-scrollbar');
 const overflow=await scroll.evaluate(e=>e.scrollWidth > e.clientWidth + 1);
 assert.equal(await top.isVisible(), overflow);
 if(overflow) {
  await top.scrollIntoViewIfNeeded();
  const topHandle=await top.elementHandle(), bottomHandle=await scroll.elementHandle();
  // ResizeObserver and native scroll events can settle on different frames in WebKit.
  await p.waitForFunction(({a,b})=>Math.abs((a.scrollWidth-a.clientWidth)-(b.scrollWidth-b.clientWidth))<=1,{a:topHandle,b:bottomHandle});
  const sync=async (source,target,x)=>{
   const expected=await source.evaluate((e,x)=>{e.scrollLeft=x;return e.scrollLeft;},x);
   try { await p.waitForFunction(({target,expected})=>Math.abs(target.scrollLeft-expected)<=1,{target:await target.elementHandle(),expected},{timeout:5000}); }
   catch(error){throw new Error(`Scroll synchronization: ${label} at ${width}px; expected ${expected}, source ${JSON.stringify(await source.evaluate(e=>({left:e.scrollLeft,range:e.scrollWidth-e.clientWidth})))}, target ${JSON.stringify(await target.evaluate(e=>({left:e.scrollLeft,range:e.scrollWidth-e.clientWidth})))}`,{cause:error});}
   return expected;
  };
  assert.ok(await sync(top,scroll,100)>0,'top scrollbar actually moves the table');
  assert.ok(await sync(scroll,top,200)>0,'bottom scrollbar actually moves the top scrollbar');
  await sync(scroll,top,await scroll.evaluate(e=>e.scrollWidth));
  assert.ok(await scroll.evaluate(e=>Math.abs(e.scrollLeft-(e.scrollWidth-e.clientWidth))<=1),'bottom scrollbar reaches the final column');
  await sync(top,scroll,0); assert.equal(await scroll.evaluate(e=>e.scrollLeft),0);
 }

 await scroll.evaluate(e=>{e.scrollLeft=0;e.scrollTop=180});
 const offset=await table.locator('thead th').first().evaluate(e=>e.getBoundingClientRect().top-e.closest('.table-scroll').getBoundingClientRect().top);
 assert.ok(offset>=0 && offset<=3,'header stays sticky during vertical scroll');
 await scroll.evaluate(e=>e.scrollTop=0); await fits(p);
 return {width, label, overflow, ...await scroll.evaluate(e=>({available:e.clientWidth, content:e.scrollWidth, rows:e.querySelectorAll('tbody tr').length}))};
}
for(const engine of engines) for(const width of [280,375,768,1024,1366,1920]) test(`${engine}: redesign flows and real synchronized scrollbars at ${width}px`, async t=>{
 const p=await open(t,engine,width);await p.evaluate(()=>document.fonts.ready);await fits(p);
 assert.match(await p.locator('h1').evaluate(e=>getComputedStyle(e).fontFamily),/Michroma/);
 assert.equal(await p.locator('h1').evaluate(()=>document.fonts.check('16px Michroma')),true);
 const shot=async name=>{ await p.waitForTimeout(260); await p.screenshot({path:`artifacts/ui/stage-15/${engine}-${name}-${width}.png`, fullPage:name==='league'}); };
 await shot('home');await p.locator('.main-cards button').first().click();await fits(p);
 const actual=await verifyTable(p,'SportsDataverse oyuncu istatistikleri',width);
 assert.equal(await p.locator('.session-note').count(),0,'central rankings omit the manual-session notice');
 if(width<=650) {
  const colors=await p.locator('.top-scrollbar:visible').evaluate(e=>CSS.supports('scrollbar-color','#4f657d #e6edf3') ? getComputedStyle(e).scrollbarColor : getComputedStyle(e,'::-webkit-scrollbar-thumb').backgroundColor);
  assert.ok(['rgb(79, 101, 125) rgb(230, 237, 243)','rgb(79, 101, 125)'].includes(colors),'mobile top scrollbar uses the stronger thumb contrast in native or WebKit styling');
 }
 await shot('actual');
 const actualTable=p.getByRole('region',{name:'SportsDataverse oyuncu istatistikleri',exact:true}).locator('table');
 await actualTable.getByRole('button',{name:'GP',exact:true}).click();
 const zero=await actualTable.locator('tbody tr').first().locator('td').allTextContents();assert.equal(zero[0],'—');assert.equal(zero[4],'0');assert.equal(zero[5],'0.0');assert.equal(zero[8],'—');assert.equal(zero[11],'—');assert.equal(zero[19],'—');
 await actualTable.getByRole('button',{name:'TOTAL Z',exact:true}).click();
 const frame=p.getByRole('region',{name:'SportsDataverse oyuncu istatistikleri',exact:true}).locator('..');
 await frame.getByRole('button',{name:'Sonraki',exact:true}).click();assert.match(await frame.locator('.pagination').innerText(),/Sayfa 2/);
 await p.getByLabel('Oyuncu adıyla ara',{exact:true}).fill('Cade');assert.match(await frame.locator('.pagination').innerText(),/Sayfa 1/);
 await p.getByRole('link',{name:'NBA Fantasy Assistant',exact:true}).click();await p.locator('.main-cards button').first().click();assert.equal(await p.getByLabel('Oyuncu adıyla ara',{exact:true}).inputValue(),'Cade');
 await p.getByLabel('Oyuncu adıyla ara',{exact:true}).fill('');await p.getByLabel('Dönem',{exact:true}).selectOption('projected');
 const ros=await verifyTable(p,'Projected oyuncu sıralamaları',width);
 assert.equal(await p.locator('.session-note').count(),0);
 const rosSection=p.getByRole('region',{name:'ROS projeksiyonları',exact:true});
 assert.doesNotMatch(await rosSection.locator('.stats-dates').innerText(),/GP:|MPG:/);
 const projectionHelp=rosSection.locator('details');
 const explanation=projectionHelp.getByText('GP: tahmini kalan maç · MPG: tahmini maç başı dakika',{exact:true});
 assert.equal(await explanation.isVisible(),false);
 await projectionHelp.locator('summary').click();assert.equal(await explanation.isVisible(),true);
 await projectionHelp.locator('summary').click();await p.evaluate(()=>window.scrollTo(0,0));await shot('ros');
 await p.getByRole('link',{name:'NBA Fantasy Assistant',exact:true}).click();await p.locator('.main-cards button').nth(1).click();await shot('source');await p.getByRole('button',{name:'Kendim yükleyeceğim',exact:false}).click();
 assert.equal(await p.locator('.session-note').isVisible(),true,'manual work retains session guidance');
 const opener=p.getByRole('button',{name:'Ligini oluştur',exact:false});await opener.click();await p.getByRole('dialog').getByRole('button',{name:'Lig bilgilerini kendim gireceğim',exact:true}).click();await fits(p);
 assert.equal(await p.locator('.setup-steps').isVisible(),false);assert.equal(await p.locator('.main-navigation').isVisible(),false);assert.equal(await p.getByLabel('Sezon',{exact:true}).count(),0);assert.match(await p.locator('.season-label').innerText(),/2026-27/);await shot('league');
 assert.equal(await p.locator('#setup-heading').evaluate(e=>document.activeElement===e),true);
 await p.getByRole('button',{name:'Vazgeç',exact:true}).click();await p.waitForFunction(()=>document.activeElement?.classList.contains('setup-step'));
 const raw=fresh(120), w={...raw,manualDraftLocked:true,strategies:raw.strategies.map(s=>({...s,targets:{...s.targets,PTS:'top3'}}))};
 await p.evaluate(w=>sessionStorage.setItem('nba-fantasy-assistant.session.v1',JSON.stringify(w)),w);await p.reload();
 const draft=await verifyTable(p,'Oyuncu istatistik tablosu',width);await shot('draft');
 const pool=p.getByRole('region',{name:'Oyuncu istatistik tablosu',exact:true});assert.equal(await pool.locator('tbody tr').count(),50);
 await p.getByLabel('Sıralama',{exact:true}).selectOption('PTS');await p.getByRole('button',{name:'Sıralama yönünü değiştir'}).click();assert.match(await pool.locator('tbody tr').first().innerText(),/Player 119/);
 await p.getByLabel('Oyuncu ara',{exact:true}).fill('Player 000');await pool.getByRole('button',{name:'Fixture Player 000',exact:true}).click();
 await p.keyboard.press('Escape'); await p.getByRole('link',{name:'NBA Fantasy Assistant',exact:true}).click();await p.locator('.main-cards button').nth(1).click();await p.getByRole('button',{name:'Mevcut çalışmaya devam et'}).click();assert.equal(await p.getByLabel('Oyuncu ara',{exact:true}).inputValue(),'Player 000');
 for(const tab of ['Power Rankings','Takım Kadroları','Kategori / Rakip Analizi']){await p.getByRole('tab',{name:tab,exact:true}).click();await fits(p);}
 await p.emulateMedia({reducedMotion:'reduce'});assert.equal(await p.locator('button').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
 await writeFile(`artifacts/ui/stage-15/${engine}-metrics-${width}.json`,JSON.stringify({actual,ros,draft},null,2));
});
