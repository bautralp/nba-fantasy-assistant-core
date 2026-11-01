import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {preview} from 'vite';
import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {recovery,openLeagueStep} from '../../helpers/workspaceUi.mjs';
let server,browser,base;
before(async()=>{server=await preview({preview:{host:'127.0.0.1',port:0}});base=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true});});
after(async()=>{await browser?.close();await new Promise(r=>server?.httpServer.close(r));});
async function open(t,width,demo=true){
 const context=await browser.newContext({viewport:{width,height:1000},locale:'tr-TR'});t.after(()=>context.close());
 const external=[],errors=[];await context.route('**/*',r=>{if(new URL(r.request().url()).origin===base)return r.continue();external.push(r.request().url());return r.abort();});
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-11-01T10:30:00Z')});
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(external,[],'No external provider request is permitted');});
 await page.goto(base+(demo?'?demo=synthetic':''));return page;
}
for(const width of [375,1280])test(`synthetic production build: Season, Power, Waiver and Trade at ${width}px`,async t=>{
 const p=await open(t,width);await p.getByRole('note').filter({hasText:'SENTETİK DEMO'}).waitFor();
 await p.getByRole('button',{name:/Sezon İçi Asistanı Lig/}).click();await p.getByLabel('ESPN League ID veya lig URL’si').fill('789');await p.getByRole('button',{name:'Ligi bağla',exact:true}).click();await p.getByRole('button',{name:'Sentetik Takım 4',exact:true}).click();
 await p.getByRole('button',{name:'Power Rankings',exact:true}).click();await p.locator('.season-power-card').nth(8).waitFor();
 assert.equal(await p.locator('.season-power-card tbody tr').count(),90);assert.doesNotMatch((await p.locator('.season-power-card tbody').allInnerTexts()).join(''),/—/);
 const back=()=>p.getByRole('button',{name:'← Sezon içi ana menü',exact:true}).click();
 await back();await p.getByRole('button',{name:'Takım Analizi',exact:true}).click();await p.locator('.season-contribution').first().waitFor();assert.ok(await p.locator('.season-contribution').count()>=8);
 await p.getByRole('combobox',{name:'AST hedefi'}).selectOption('top1');
 await back();await p.getByRole('button',{name:'Waiver Asistanı',exact:true}).click();const items=p.locator('.season-waiver-player');await items.first().waitFor();assert.equal(await items.count(),20);
 await items.first().getByRole('button',{name:'Ekle/bırak senaryosu'}).click();await p.getByRole('region',{name:'Ekle/bırak simülasyonu'}).locator('tbody tr').nth(8).waitFor();
 await back();await p.getByRole('button',{name:'Takas Asistanı',exact:true}).click();await p.getByRole('combobox',{name:'Takas yapılacak takım',exact:true}).waitFor();
 await p.getByRole('combobox',{name:'Synthetic Player 031 hedefi',exact:true}).selectOption('1');await p.getByRole('combobox',{name:'Synthetic Player 001 hedefi',exact:true}).selectOption('4');
 await p.getByRole('button',{name:'Takasın etkisini gör',exact:true}).click();await p.getByRole('region',{name:'Takas sonucu',exact:true}).waitFor();assert.doesNotMatch(await p.getByRole('region',{name:'Takas sonucu',exact:true}).innerText(),/NaN|Infinity/);
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No page horizontal overflow');
 mkdirSync('artifacts/public-core',{recursive:true});await p.screenshot({path:`artifacts/public-core/season-${width}.png`,fullPage:true});
});
test('ROS rankings and Draft can load the selected independent synthetic projection',async t=>{
 const p=await open(t,1280);await p.getByRole('button',{name:/Oyuncu Sıralamaları/}).click();await p.getByLabel('Dönem',{exact:true}).selectOption('projected');
 await p.getByRole('region',{name:'ROS projeksiyonları'}).getByRole('table').waitFor();assert.ok(await p.getByRole('region',{name:'ROS projeksiyonları'}).locator('tbody tr').count()>0);
 await p.getByTitle('Ana menüye dön').click();await p.getByRole('button',{name:/^Draft Asistanı/}).click();
 await p.getByRole('button',{name:/Fantasy Assistant verilerini kullan/}).click();
 await p.getByRole('heading',{name:'Draft için hazırlan',exact:true}).waitFor();
 await openLeagueStep(p);await p.getByLabel('Lig adı',{exact:true}).fill('Sentetik Draft Ligi');
 for(let i=1;i<=10;i++)await p.getByLabel(`Takım ${i} adı`,{exact:true}).fill(`Demo Takım ${i}`);
 await p.getByLabel('Kendi takımın',{exact:true}).selectOption({label:'Demo Takım 4'});await p.getByRole('button',{name:'Lig oluştur ve kaydet',exact:true}).click();
 await p.locator('.setup-step').nth(2).click();
 await p.getByRole('button',{name:'Merkezi kaynağı uygula',exact:true}).click();
 await p.getByRole('button',{name:'Merkezi kaynağı uygula',exact:true}).waitFor();
 await recovery(p);const download=p.waitForEvent('download');await p.getByRole('button',{name:'JSON yedeğini indir',exact:true}).click();const file=await download;const workspace=JSON.parse(await readFile(await file.path(),'utf8'));assert.equal(workspace.players.length,220);assert.ok(workspace.players.every(row=>row.name.startsWith('Synthetic Player ')));
 assert.ok(await p.locator('body').innerText().then(s=>s.includes('Sentetik')||s.includes('SENTETİK')));
});
test('default public mode does not silently fall back to demo or live league',async t=>{
 const p=await open(t,1280,false);await p.getByRole('note').filter({hasText:'Public Core'}).waitFor();
 await p.getByRole('button',{name:/Sezon İçi Asistanı Lig/}).click();await p.getByLabel('ESPN League ID veya lig URL’si').fill('789');await p.getByRole('button',{name:'Ligi bağla',exact:true}).click();
 await p.getByRole('alert').waitFor();assert.equal(await p.getByRole('button',{name:'Sentetik Takım 4',exact:true}).count(),0);
});
