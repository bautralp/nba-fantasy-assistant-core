import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fresh } from '../helpers/draftFixture.ts';
import { enterDraft } from '../helpers/workspaceUi.mjs';
import { selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { PLAYER_COLUMNS } from '../../src/shared/playerTableModel.ts';
const engines=(process.env.BROWSER_ENGINES||'chromium').split(',');
let server,base;
before(async()=>{server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();base=`http://127.0.0.1:${server.httpServer.address().port}`;await mkdir('artifacts/ui/stage-15-1',{recursive:true});});
after(async()=>server?.close());
function fixture(){
 const raw=fresh(120);
 return {...raw,manualDraftLocked:true,projections:raw.projections.map(({rank,...p})=>p.playerId==='p119'?{playerId:p.playerId,datasetId:p.datasetId,status:'excluded',reasons:['test excluded']}:p),strategies:raw.strategies.map(s=>({...s,targets:{...s.targets,PTS:'top3'}}))};
}
for(const engine of engines) for(const width of [375,768,1024,1366,1920]) test(`${engine}: Draft ranks, row activation and recommendation layout at ${width}px`,async t=>{
 const browser=await({chromium,firefox,webkit})[engine].launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width,height:1000},locale:'tr-TR',...(engine==='chromium'?{hasTouch:true}:{})});
 const w=fixture(),expected=selectDraftWorkspace(w);
 await context.addInitScript(w=>{if(!sessionStorage.seeded){sessionStorage.setItem('nba-fantasy-assistant.session.v1',JSON.stringify(w));sessionStorage.seeded='1';}},w);
 const p=await context.newPage();p.setDefaultTimeout(8000);const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await p.goto(base);await enterDraft(p);
 const pool=p.getByRole('region',{name:'Oyuncu istatistik tablosu',exact:true}),table=pool.locator('table'),rows=table.locator('tbody tr'),frame=pool.locator('..'),top=frame.locator('.top-scrollbar');
 // React applies search/filter/sort/page changes asynchronously. Poll until the value matches, then assert the same expected value.
 const settled=async(read,expected)=>{for(let i=0;i<100&&await read().catch(()=>undefined)!==expected;i++)await p.waitForTimeout(50);assert.equal(await read(),expected);};
 const firstRank=expected=>settled(()=>rows.first().locator('td').first().innerText({timeout:1000}),expected);
 await table.waitFor();assert.equal(await rows.count(),50);assert.deepEqual(await table.locator('thead button').allTextContents(),[...PLAYER_COLUMNS]);
 assert.match(await p.locator('.pool-rank-info').innerText(),/9CAT TOTAL Z/);
 const firstName=await rows.first().locator('.player-link').innerText();
 const firstId=w.players.find(x=>x.name===firstName).id;
 assert.equal(await rows.first().locator('td').first().innerText(),'1');assert.equal(expected.poolRanking.ranks.get(firstId),1);
 const boxes=await p.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}};return{pool:box('.pool-panel'),recommendations:box('.recommendations-panel'),pageWidth:document.documentElement.scrollWidth,viewport:innerWidth};});
 assert.ok(boxes.pageWidth<=width,'whole page has no horizontal overflow');
 if(width>=1280){assert.ok(boxes.recommendations.x>=boxes.pool.right+10);assert.ok(Math.abs(boxes.pool.y-boxes.recommendations.y)<=2);assert.ok(boxes.recommendations.width>=300&&boxes.recommendations.width<=350);}else assert.ok(boxes.recommendations.y>=boxes.pool.y+boxes.pool.height);
 const overflow=await pool.evaluate(e=>e.scrollWidth>e.clientWidth+1);assert.equal(await top.isVisible(),overflow);
 if(overflow){
  const a=await top.elementHandle(),b=await pool.elementHandle();await p.waitForFunction(({a,b})=>Math.abs((a.scrollWidth-a.clientWidth)-(b.scrollWidth-b.clientWidth))<=1,{a,b});
  await top.evaluate(e=>e.scrollLeft=150);await p.waitForFunction(({a,b})=>Math.abs(a.scrollLeft-b.scrollLeft)<=1&&b.scrollLeft>0,{a,b});
  const rightBefore=await p.locator('.recommendations-panel').boundingBox();
  await pool.evaluate(e=>e.scrollLeft=e.scrollWidth);await p.waitForFunction(({a,b})=>Math.abs(a.scrollLeft-b.scrollLeft)<=1,{a,b});
  assert.equal((await p.locator('.recommendations-panel').boundingBox()).x,rightBefore.x,'pool scroll never moves the recommendation rail');
  await top.evaluate(e=>e.scrollLeft=0);await p.waitForFunction(({a,b})=>a.scrollLeft===0&&b.scrollLeft===0,{a,b});
 }
 await p.evaluate(()=>window.scrollTo(0,0));await p.mouse.move(0,0);await p.waitForTimeout(260);
 await p.screenshot({path:`artifacts/ui/stage-15-1/${engine}-draft-${width}.png`});
 if(width>=1366){await p.locator('.draft-columns').scrollIntoViewIfNeeded();await p.mouse.move(0,0);await p.screenshot({path:`artifacts/ui/stage-15-1/${engine}-draft-panels-${width}.png`});}
 const dialog=p.getByRole('dialog');
 await rows.first().locator('td').nth(12).click();await dialog.waitFor();assert.match(await dialog.innerText(),new RegExp(firstName));assert.equal(await dialog.count(),1);
 await p.keyboard.press('Escape');await rows.first().getByRole('button',{name:firstName,exact:true}).click();assert.equal(await dialog.count(),1);
 await dialog.getByRole('button',{name:'Ata',exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.equal(await rows.first().locator('td').first().innerText(),'1','picking never changes global rank');
 await rows.first().locator('td').nth(12).click();await dialog.getByText(/Seçili: Fixture Team 0/).waitFor();assert.ok(await dialog.getByRole('button',{name:'Takımını değiştir',exact:true}).count());await p.keyboard.press('Escape');
 await rows.first().focus();await p.keyboard.press('Enter');await dialog.waitFor();await p.keyboard.press('Escape');
 assert.equal(await rows.first().evaluate(e=>document.activeElement===e),true);await p.keyboard.press('Space');await dialog.waitFor();await p.keyboard.press('Escape');
 await p.getByLabel('Sıralama',{exact:true}).selectOption('PTS');await table.getByRole('button',{name:'PTS',exact:true}).click();assert.equal(await dialog.count(),0,'header sorts without opening assignment');
 await p.getByLabel('Sıralama',{exact:true}).selectOption('RANK');await firstRank('1');
 await frame.getByRole('button',{name:'Sonraki',exact:true}).click();await firstRank('51');
 await p.getByLabel('Oyuncu ara',{exact:true}).fill(firstName);await firstRank('1');assert.match(await frame.locator('.pagination').innerText(),/Sayfa 1/);
 await p.getByLabel('Pozisyon',{exact:true}).selectOption(expected.positions.get(firstId)[0]);await firstRank('1');
 await p.getByLabel('Draft filtresi',{exact:true}).selectOption('picked');await settled(()=>rows.count(),1);assert.equal(await rows.first().locator('td').first().innerText(),'1');
 await p.getByLabel('Oyuncu ara',{exact:true}).fill('');await p.getByLabel('Pozisyon',{exact:true}).selectOption('');await p.getByLabel('Draft filtresi',{exact:true}).selectOption('all');
 const recommendation=p.locator('.recommendation-list .player-link').first();await recommendation.click();await dialog.waitFor();await p.keyboard.press('Escape');
 await p.getByLabel('Oyuncu ara',{exact:true}).fill('Fixture Player 119');await firstRank('—');await rows.first().locator('td').nth(4).click();await dialog.getByText('Analiz dışı: test excluded',{exact:true}).waitFor();await p.keyboard.press('Escape');
 await p.getByLabel('Oyuncu ara',{exact:true}).fill('');await pool.evaluate(e=>e.scrollLeft=0);
 // A real pointer drag over a numeric cell must not activate the row on release.
 const cell=rows.first().locator('td').nth(4);await cell.scrollIntoViewIfNeeded();const rect=await cell.boundingBox();await p.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await p.mouse.down();await p.mouse.move(rect.x+rect.width/2-30,rect.y+rect.height/2,{steps:5});await p.mouse.up();assert.equal(await dialog.count(),0);
 // Browsers cancel a touch pointer when native panning takes over. Even a late click is suppressed.
 await rows.first().dispatchEvent('pointerdown',{clientX:200,clientY:500,pointerType:'touch'});await rows.first().dispatchEvent('pointermove',{clientX:100,clientY:500,pointerType:'touch'});await rows.first().dispatchEvent('pointercancel',{pointerType:'touch'});await rows.first().dispatchEvent('click',{clientX:100,clientY:500,detail:1});assert.equal(await dialog.count(),0);
 if(engine==='chromium'&&width===375){
  await pool.evaluate(e=>e.scrollLeft=0);await rows.first().locator('.player-link').scrollIntoViewIfNeeded();
  const bounds=await pool.boundingBox(),x=bounds.x+bounds.width-25,y=bounds.y+90;
  const cdp=await context.newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let step=1;step<=6;step++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-step*20,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await p.waitForFunction(e=>e.scrollLeft>0,await pool.elementHandle());assert.equal(await dialog.count(),0,'native mobile swipe scrolls without opening assignment');await cdp.detach();
 }
 await p.reload();await table.waitFor();assert.equal(await rows.first().locator('td').first().innerText(),'1');assert.equal(await rows.first().locator('.player-link').innerText(),firstName);
 await writeFile(`artifacts/ui/stage-15-1/${engine}-metrics-${width}.json`,JSON.stringify({...boxes,table:await pool.evaluate(e=>({available:e.clientWidth,content:e.scrollWidth})),firstName,firstId,source:expected.poolRanking.source},null,2));
});
