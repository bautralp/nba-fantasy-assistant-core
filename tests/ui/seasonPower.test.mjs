import { unifiedScenario, unifiedStandard, unifiedSchedule } from '../helpers/unifiedScenario.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { adaptCentralRos, parseAnalysisSchedule } from '../../src/seasonAnalysis/centralAdapter.ts';
import { analyzeLeague } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { CATEGORIES } from '../../src/seasonAnalysis/model.ts';
import { normalizeLeague } from '../../src/infrastructure/espn/normalize.ts';
const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const ros = unifiedStandard, schedule = unifiedSchedule;
const scenario = unifiedScenario;
const real = read('../fixtures/season-analysis/public-league-normalized.json');
const selected = ros.players.filter(p => p.status === 'available' && p.rosGP > 0 && p.teamId && p.eligibility.status === 'verified').slice(0,10);
function syntheticLeague(n = 10) {
 return { id: 789, seasonId: 2027, scoringPeriodId: 1, status: { currentMatchupPeriod: 1 }, settings: { name: 'Synthetic Power UI league · real ROS rates', isPublic: true, scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', allowOutOfPositionScoring: false, scoringItems: [19,20,17,6,3,2,1,11,0].map(statId => ({statId, points:1,isReverseItem:statId===11})) }, rosterSettings: { lineupLocktimeType:'INDIVIDUAL_GAME', rosterLocktimeType:'FIRSTGAME_SCORINGPERIOD', lineupSlotStatLimits:{}, lineupSlotCounts:{11:1,12:0,13:1} } }, teams: selected.slice(0,n).map((p,i)=>({ id:i+1,name:`Synthetic team ${i+1}`,roster:{entries:[{playerId:Number(p.id),lineupSlotId:11,playerPoolEntry:{player:{id:Number(p.id),fullName:p.name,proTeamId:p.teamId,eligibleSlots:[11,12,13]}}}]}})) };
}
let server, base;
before(async()=>{server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();base='http://127.0.0.1:'+server.httpServer.address().port;});
after(async()=>{await server?.close();});
function realLeague() {
 const raw=syntheticLeague(); raw.settings.name='Gerçek lig kadrosu · anonimleştirilmiş kayıt';
 raw.settings.rosterSettings.lineupSlotCounts=Object.fromEntries(real.rosterSlots.map(s=>[s.slotId,s.count]));
 raw.teams=real.teams.map(t=>({id:t.espnTeamId,name:t.name,roster:{entries:t.roster.map(v=>({playerId:v.espnPlayerId,lineupSlotId:v.lineupSlotId,playerPoolEntry:{player:{id:v.espnPlayerId,fullName:v.name,proTeamId:v.proTeamId,eligibleSlots:v.eligibleSlotIds}}}))}}));
 return raw;
}
async function open(t, engine, width, {raw=syntheticLeague(), enter=true}={}) {
 const browser=await ({chromium,firefox,webkit})[engine].launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})}); t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:1000}}); const errors=[]; page.on('pageerror',e=>errors.push(e.message)); t.after(()=>assert.deepEqual(errors,[]));
 await page.clock.install({time:new Date(Date.parse(schedule.retrievedAt)+3600000)});
 await page.route('**/data/player-projections.json',r=>r.fulfill({json:ros}));
 await page.route('**/data/analysis-schedule.json',r=>r.fulfill({json:schedule}));
 await page.route('**/data/projection-scenarios.json',r=>r.fulfill({json:scenario}));
 await page.route('https://lm-api-reads.fantasy.espn.com/**',r=>r.fulfill({json:raw}));
 await page.goto(base); await page.getByRole('button',{name:/Sezon İçi Asistanı Lig/}).click();
 await page.getByLabel('ESPN League ID veya lig URL’si').fill(String(raw.id)); await page.getByRole('button',{name:'Ligi bağla',exact:true}).click();
 await page.getByRole('button',{name:raw.teams[3].name,exact:true}).click();
 if(enter) { await page.getByRole('button',{name:'Power Rankings',exact:true}).click(); await page.locator('.season-power-card').nth(8).waitFor(); }
 return page;
}
const capture=async(p,name)=>{if(process.env.SEASON_CAPTURE_DIR){mkdirSync(process.env.SEASON_CAPTURE_DIR,{recursive:true});await p.screenshot({path:join(process.env.SEASON_CAPTURE_DIR,name+'.png'),fullPage:true});}};
const region=p=>p.getByRole('region',{name:'9CAT Power Rankings'});
const enter=async p=>p.getByRole('button',{name:'Power Rankings',exact:true}).click();
const back=async p=>p.getByRole('button',{name:'← Sezon içi ana menü',exact:true}).click();
for(const engine of (process.env.BROWSER_ENGINES||'chromium').split(',')) {
 for(const width of [320,375,1280,1920]) test(`${engine}: Power Rankings ${width}px automatically shows all teams and numeric values`,async t=>{
  const p=await open(t,engine,width);
  assert.equal(await p.locator('.season-power-card tbody tr').count(),90); assert.equal(await p.locator('.season-power-card tr.is-mine').count(),9);
  assert.equal(await p.locator('.season-power-summary a').count(),9); assert.doesNotMatch((await p.locator('.season-power-card tbody').allInnerTexts()).join(''),/—/);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const boxes=await p.locator('.season-power-card').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y};}));
  if(width>=900)assert.ok(boxes[1].x>boxes[0].x);else assert.ok(boxes[1].y>boxes[0].y);
  await p.locator('.season-power-summary a').first().focus(); await p.keyboard.press('Enter'); await p.waitForURL(/#season-power-FGpct$/);
  assert.equal(await region(p).locator('details, button').count(),0);
  assert.doesNotMatch(await region(p).innerText(),/Standart|Genişletilmiş|Model|SHA|revizyon|Bilimsel|GP|z-score|Farklar ve kapsam/);
  assert.equal(await p.getByRole('button',{name:/yenile/}).count(),0);
  assert.equal(await p.locator('.season-power-card thead th').count(),27);
 });
 test(`${engine}: six-team league shows every team`,async t=>{
  const p=await open(t,engine,375,{raw:syntheticLeague(6)}); assert.equal(await p.locator('.season-power-card tbody tr').count(),54);
 });
 for(const width of [375,1280]) test(`${engine}: real ten-team extended pipeline displays all 90 exact projections at ${width}px`,async t=>{
  const raw=process.env.SEASON_LIVE_LEAGUE_FILE?JSON.parse(readFileSync(process.env.SEASON_LIVE_LEAGUE_FILE,'utf8')):realLeague();
  const p=await open(t,engine,width,{raw});
  const adapted=adaptCentralRos(scenario.projection,parseAnalysisSchedule(schedule));
  const expected=analyzeLeague({league:normalizeLeague(raw,raw.id,2027),...adapted,schedule:parseAnalysisSchedule(schedule),asOf:scenario.asOf,dataUpdatedAt:scenario.projection.generatedAt,lineupPolicy:'daily-max-games'});
  assert.equal(expected.coverage.rankedCategories,9);
  for(const [i,c] of CATEGORIES.entries()) {
   const table=p.locator('.season-power-card').nth(i);
   assert.equal(await table.locator('tbody tr').count(),10);
   for(const [j,r] of expected.rankings[c].entries()) {
    const row=table.locator('tbody tr').nth(j);
    assert.equal(await row.locator('td').first().innerText(),String(r.rank));
    assert.equal(await row.locator('td').last().innerText(),r.projectedValue.toLocaleString('tr-TR',{minimumFractionDigits:1,maximumFractionDigits:1})+(c.includes('%')?'%':''));
   }
  }
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(engine==='chromium') await capture(p,`season-power-real-extended-${width}`);
 });
 test(`${engine}: verified numeric values survive the ESPN cache TTL and five minutes on screen`,async t=>{
  const p=await open(t,engine,375);
  const before=await p.locator('.season-power-card tbody').allInnerTexts(); assert.doesNotMatch(before.join(''),/—/);
  await p.clock.runFor(61_000); assert.deepEqual(await p.locator('.season-power-card tbody').allInnerTexts(),before);
  await p.clock.runFor(240_000); assert.deepEqual(await p.locator('.season-power-card tbody').allInnerTexts(),before);
 });
 test(`${engine}: StrictMode loads each publication file once and fresh ESPN is reused`,async t=>{
  const p=await open(t,engine,375,{enter:false}); const counts={};
  p.on('request',r=>{const path=new URL(r.url()).pathname;if(path.includes('/data/')||path.includes('/leagues/'))counts[path]=(counts[path]||0)+1;});
  await enter(p); await p.locator('.season-power-card').nth(8).waitFor();
  for(const file of ['player-projections.json','analysis-schedule.json','projection-scenarios.json'])assert.equal(counts['/data/'+file],1);
  assert.equal(Object.keys(counts).some(k=>k.includes('/leagues/')),false);
 });
 test(`${engine}: expired ESPN snapshot refreshes on entry and never mixes roster revisions`,async t=>{
  const p=await open(t,engine,375); await back(p); await p.clock.runFor(61_000);
  let release; const pending=new Promise(resolve=>release=resolve); let calls=0;
  const newer=syntheticLeague(); newer.teams.forEach(t=>{t.name+=' Yeni';});
  await p.route('https://lm-api-reads.fantasy.espn.com/**',async r=>{calls++;await pending;await r.fulfill({json:newer});});
  await enter(p); await region(p).getByRole('status').waitFor(); assert.equal(await p.locator('.season-power-card').count(),0);
  release(); await p.locator('.season-power-card').nth(8).waitFor();
  assert.equal(calls,1); assert.equal(await p.locator('.season-power-card tbody th').filter({hasText:'Yeni'}).count(),90);
  assert.doesNotMatch((await p.locator('.season-power-card tbody').allInnerTexts()).join(''),/—/);
 });
 for(const failure of ['schedule-sha','scenario-date','missing-player','old-publication','http','timeout','espn-429']) test(`${engine}: ${failure} shows one short error and no empty tables or fallback`,async t=>{
  const raw=syntheticLeague(); if(failure==='missing-player') {raw.teams[0].roster.entries[0].playerId=999999999;raw.teams[0].roster.entries[0].playerPoolEntry.player.id=999999999;}
  const p=await open(t,engine,375,{raw,enter:false});
  if(failure==='schedule-sha') await p.route('**/data/analysis-schedule.json',r=>r.fulfill({json:{...schedule,source:{...schedule.source,sha256:'0'.repeat(64)}}}));
  if(failure==='scenario-date') await p.route('**/data/projection-scenarios.json',r=>r.fulfill({json:{...scenario,standardGeneratedAt:'2026-10-24T00:00:00Z'}}));
  if(failure==='http') await p.route('**/data/projection-scenarios.json',r=>r.fulfill({status:503,body:'unavailable'}));
  if(failure==='timeout') await p.route('**/data/projection-scenarios.json',()=>{});
  if(failure==='old-publication') await p.clock.fastForward(37*3600000);
  let espnCalls=0;
  if(failure==='espn-429') {
   await p.clock.runFor(61_000);
   await p.route('https://lm-api-reads.fantasy.espn.com/**',r=>{espnCalls++;return r.fulfill({status:429,headers:{'retry-after':'30'},body:'{}'});});
  }
  const requested=failure==='timeout'?p.waitForRequest('**/data/projection-scenarios.json'):null;
  await enter(p);
  if(requested) {await requested;await p.clock.runFor(20_001);}
  const alert=region(p).getByRole('alert'); await alert.waitFor(); assert.equal(await alert.count(),1);
  assert.equal(await alert.innerText(),['http','timeout','espn-429'].includes(failure)?'Sıralamalar şu anda yüklenemedi.':'Güncel sıralama verileri henüz hazır değil.');
  assert.equal(await p.locator('.season-power-card').count(),0);
  if(failure==='espn-429') {await back(p);await enter(p);await alert.waitFor();assert.equal(espnCalls,1);}
 });
 test(`${engine}: a new incompatible publication clears previous success and recovers on the next visit`,async t=>{
  const p=await open(t,engine,375);await back(p);
  await p.route('**/data/analysis-schedule.json',r=>r.fulfill({json:{...schedule,asOf:'2026-10-24'}}));
  await enter(p);await region(p).getByRole('alert').waitFor();assert.equal(await p.locator('.season-power-card').count(),0);
  await back(p);await p.unroute('**/data/analysis-schedule.json');await p.route('**/data/analysis-schedule.json',r=>r.fulfill({json:schedule}));
  await enter(p);await p.locator('.season-power-card').nth(8).waitFor();
  assert.equal(await region(p).locator('time').getAttribute('datetime'),ros.generatedAt);
  assert.doesNotMatch((await p.locator('.season-power-card tbody').allInnerTexts()).join(''),/—/);
 });
 test(`${engine}: aborted old publication cannot replace a later successful screen`,async t=>{
  const p=await open(t,engine,375,{enter:false}); let release;const pending=new Promise(resolve=>release=resolve);
  await p.route('**/data/projection-scenarios.json',async r=>{await pending;await r.fulfill({status:503,body:'late failure'}).catch(()=>{});});
  const requested=p.waitForRequest('**/data/projection-scenarios.json');await enter(p);await requested;await back(p);
  await p.unroute('**/data/projection-scenarios.json');await p.route('**/data/projection-scenarios.json',r=>r.fulfill({json:scenario}));
  await enter(p);await p.locator('.season-power-card').nth(8).waitFor();release();await p.clock.runFor(21_000);
  assert.equal(await region(p).getByRole('alert').count(),0);assert.equal(await p.locator('.season-power-card tbody tr').count(),90);
 });
}
