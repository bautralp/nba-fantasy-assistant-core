import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { seasonUiFixture } from '../helpers/seasonUiFixture.mjs';
let server, base;
before(async()=>{server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();base='http://127.0.0.1:'+server.httpServer.address().port;});
after(async()=>{await server?.close();});
async function open(t,engine,width=375) {
 const browser=await ({chromium,firefox,webkit})[engine].launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:1000}}),raw=seasonUiFixture(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.route('https://lm-api-reads.fantasy.espn.com/**',r=>r.fulfill({json:raw}));await page.goto(base);
 await page.getByRole('button',{name:/Sezon İçi Asistanı Lig/}).click();await page.getByLabel('ESPN League ID veya lig URL’si').fill('789');
 await page.getByRole('button',{name:'Ligi bağla',exact:true}).click();await page.getByRole('button',{name:raw.teams[3].name,exact:true}).click();
 return {page,raw};
}
const back = p=>p.getByRole('button',{name:'← Sezon içi ana menü',exact:true}).click();
const fits = p=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
async function capture(page,engine,name) {
 if(engine!=='chromium'||!process.env.SEASON_CAPTURE_DIR)return;
 await mkdir(process.env.SEASON_CAPTURE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SEASON_CAPTURE_DIR,name+'.png'),fullPage:true});
}
for(const engine of (process.env.BROWSER_ENGINES||'chromium').split(',')) {
 for(const width of [320,375,1024,1280,1920]) test(`${engine}: compact season layout ${width}px preserves complete comparisons and table semantics`,async t=>{
  const {page:p}=await open(t,engine,width);
  await p.getByRole('button',{name:'Haftalık Eşleşmeler',exact:true}).click();await p.locator('.matchup-card').nth(4).waitFor();
  const rects=await p.locator('.matchup-card').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,bottom:r.bottom,width:r.width};}));
  assert.equal(rects.length,5);
  if(width>=900){assert.ok(rects[1].x>rects[0].x);assert.ok(Math.abs(rects[1].y-rects[0].y)<1);assert.ok(Math.abs(rects[2].x-rects[0].x)<1);}
  else {assert.ok(Math.abs(rects[1].x-rects[0].x)<1);assert.ok(rects[1].y>=rects[0].bottom+10);}
  assert.ok(rects.every(r=>r.width<=590&&r.bottom-r.y<460));
  const own=p.locator('.matchup-card').first();assert.match(await own.innerText(),/Benim eşleşmem/);assert.equal(await own.locator('tbody tr').count(),9);
  assert.match(await own.locator('.matchup-totals').innerText(),/7 \/ 1 \/ 1/);
  assert.match(await own.getByRole('rowheader',{name:/^FG%/}).locator('..').innerText(),/45,0%/);
  assert.match(await own.getByRole('rowheader',{name:/^FT%/}).locator('..').innerText(),/80,0%/);
  assert.equal(await own.getByRole('rowheader',{name:/^TO/}).locator('..').locator('td').first().getAttribute('class'),'category-leading');
  assert.ok(await own.locator('.category-marker .sr-only').count()>0);assert.equal(await fits(p),true);
  await capture(p,engine,`weekly-${width}`);
  await back(p);await p.getByRole('button',{name:'Kadrolar',exact:true}).click();await p.locator('.season-roster-card').nth(9).waitFor();
  assert.match(await p.locator('.season-roster-card').first().innerText(),/Benim takımım/);
  assert.deepEqual(await p.locator('.season-roster-card').first().locator('.season-roster strong').allTextContents(),['T4 Guard','T4 Multi','T4 Forward','T4 Power','T4 Center','T4 Unknown']);
  assert.deepEqual(await p.locator('.season-roster-card').first().locator('.roster-positions').allTextContents(),['PG · SG','C · PG · SG','SF · PF','PF','C','Pozisyon bilinmiyor']);
  assert.equal(await p.locator('.season-roster-card').first().locator('.season-roster li').count(),6);assert.equal(await fits(p),true);
  if(width===375||width===1280)await capture(p,engine,`rosters-${width}`);
  await back(p);await p.getByRole('button',{name:'Standings',exact:true}).click();await p.locator('.season-standings-table tbody tr').nth(9).waitFor();
  assert.equal(await p.getByRole('table').count(),1);assert.match(await p.locator('caption').innerText(),/Hesaplanan geçici sıralama/);
  const mine=p.locator('.season-standings-table tr.is-mine');assert.match(await mine.innerText(),/Benim takımım/);assert.match(await mine.innerText(),/50,0%/);
  assert.ok(await p.locator('.season-standings-table .sr-only').filter({hasText:'Eşit sıra'}).count()>=2);
  const zero=p.locator('.season-standings-table tbody tr').filter({hasText:'Örnek Takım 6'});assert.equal(await zero.locator('td').first().innerText(),'—');assert.equal(await zero.locator('td').nth(5).innerText(),'—');
  const missing=p.locator('.season-standings-table tbody tr').filter({hasText:'Örnek Takım 7'});assert.ok((await missing.locator('td').allTextContents()).every(text=>text==='—'));
  assert.equal(await fits(p),true);const scroll=p.getByRole('region',{name:'Lig sıralaması tablosu'});await scroll.focus();assert.equal(await scroll.evaluate(n=>n===document.activeElement),true);
  if(width<900)assert.equal(await scroll.evaluate(n=>n.scrollWidth>n.clientWidth),true);
  if(width===375||width===1280)await capture(p,engine,`standings-${width}`);
 });
 test(`${engine}: every fixture week and roster prioritize changed selection without changing other order`,async t=>{
  const {page:p,raw}=await open(t,engine,1280);
  for(const id of [4,2]) {
   if(id===2){await p.getByRole('button',{name:'Takım değiştir',exact:true}).click();await p.getByRole('button',{name:raw.teams[1].name,exact:true}).click();}
   await p.getByRole('button',{name:'Fikstür',exact:true}).click();const week=p.getByRole('combobox',{name:'Hafta',exact:true});await week.waitFor();
   for(const value of ['2','4','7']) {
    await week.selectOption(value);await p.getByRole('status').filter({hasText:`${value}. hafta`}).waitFor();
    const names=await p.locator('.matchup-card').first().locator('.matchup-teams h4').allTextContents();assert.ok(names.includes(raw.teams[id-1].name));
    const original=raw.schedule.filter(m=>m.matchupPeriodId===Number(value));const expected=[...original.filter(m=>[m.home.teamId,m.away.teamId].includes(id)),...original.filter(m=>![m.home.teamId,m.away.teamId].includes(id))].map(m=>[raw.teams[m.home.teamId-1].name,raw.teams[m.away.teamId-1].name]);
    assert.deepEqual(await p.locator('.matchup-card').evaluateAll(nodes=>nodes.map(n=>[...n.querySelectorAll('.matchup-teams h4')].map(t=>t.textContent))),expected);
    if(value==='7')assert.doesNotMatch(await p.locator('.matchups-grid').innerText(),/0 \/ 0 \/ 0|▲/);
   }
   await back(p);await p.getByRole('button',{name:'Kadrolar',exact:true}).click();await p.locator('.season-roster-card').nth(9).waitFor();assert.equal(await p.locator('.season-roster-card').first().locator('h4').innerText(),raw.teams[id-1].name);await back(p);
  }
 });
}
