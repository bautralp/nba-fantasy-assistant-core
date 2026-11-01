import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fresh as rawFresh } from '../helpers/draftFixture.ts';
import { createWorkbook } from '../../src/infrastructure/projections/workbook.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { enterDraft, recovery, importPool, tab } from '../helpers/workspaceUi.mjs';
const fresh=(n)=>{const w=rawFresh(n);return applyDraftCommand(w,{kind:'strategy',targets:{...w.strategies[0].targets,PTS:'top3'}});};
const root=resolve(process.argv[2] || '.');
const server=await createServer({root,server:{host:'127.0.0.1',port:0}}); await server.listen();
const base=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || undefined});
const results=[];
const timed=async fn=>{const start=performance.now();await fn();return performance.now()-start;};
try {
 for(const size of [150,300,600]) {
  const samples=[];
  for(let run=0;run<4;run++) {
   const context=await browser.newContext();
   await context.addInitScript(w=>{if(!sessionStorage.getItem('nba-fantasy-assistant.session.v1'))sessionStorage.setItem('nba-fantasy-assistant.session.v1',JSON.stringify(w));},fresh(size));
   const p=await context.newPage(); const row={};
   row.startup=await timed(async()=>{await p.goto(base); await enterDraft(p);await p.getByRole('heading',{name:'Oyuncu havuzu',exact:true}).waitFor();});
   const scroller=p.getByRole('region',{name:'Oyuncu istatistik tablosu',exact:true});
   row.searchSort=await timed(async()=>{await p.getByLabel('Sıralama',{exact:true}).selectOption('TOTAL Z');await p.getByLabel('Oyuncu ara',{exact:true}).fill('Player 001');await scroller.getByRole('button',{name:'Fixture Player 001',exact:true}).waitFor();});
   row.pickAndPanels=await timed(async()=>{await scroller.getByRole('button',{name:'Fixture Player 001',exact:true}).click();await p.getByRole('dialog').getByRole('button',{name:'Ata',exact:true}).click();await p.locator('.team-roster[data-team-id="t0"] button').waitFor({state:'attached'});});
   // Independent preparation fixture: live drafts cannot replace their pool.
   const prep=fresh(size); await p.evaluate(w=>sessionStorage.setItem('nba-fantasy-assistant.session.v1',JSON.stringify({...w,players:[],datasets:[],projections:[],eligibility:[],league:{...w.league,activeDatasetId:null}})),prep); await p.reload();
   await importPool(p);
   const w=fresh(size); const bytes=createWorkbook('fixture','perGame',w.projections.map((r,i)=>[w.players[i].name,'C',i+1,r.gamesPlayed,...['FGM','FGA','FTM','FTA','3PM','PTS','REB','AST','STL','BLK','TO'].map(k=>r.stats[k])]));
   row.xlsxPreview=await timed(async()=>{await p.getByLabel('Oyuncu projeksiyonu dosyası').setInputFiles({name:'synthetic.xlsx',buffer:Buffer.from(bytes)});await p.getByRole('heading',{name:'Projeksiyon önizlemesi',exact:true}).waitFor();});
   row.applyAndPanels=await timed(async()=>{await p.getByRole('button',{name:'Yüklemeyi uygula',exact:true}).click();await p.getByRole('heading',{name:'Oyuncu havuzu',exact:true}).waitFor();});
   await recovery(p); row.backup=await timed(async()=>{const d=p.waitForEvent('download');await p.getByRole('button',{name:'JSON yedeğini indir',exact:true}).click();await (await d).path();});
   row.domElements=await p.locator('*').count();
   assert.ok(row.domElements<5000,'Paginated UI must keep rendered DOM bounded');
   // Per-operation budgets are intentionally broader than local medians for shared CI hosts.
   for(const k of ['searchSort','pickAndPanels','applyAndPanels','backup']) assert.ok(row[k]<2000,`${size} ${k}: ${row[k]}ms`);
   assert.ok(row.xlsxPreview<5000); assert.ok(row.startup<10000);
   await context.close(); if(run) samples.push(row);
  }
  results.push({size,median:Object.fromEntries(Object.keys(samples[0]).map(k=>[k,+samples.map(s=>s[k]).sort((a,b)=>a-b)[1].toFixed(2)]))});
 }
 await mkdir('artifacts/performance',{recursive:true});await writeFile(process.argv[3] || 'artifacts/performance/browser-after.json',JSON.stringify({methodology:'1 warmup + 3 measured runs per size; median wall ms includes Playwright interactions, development Vite and file delivery; DOM count is a deterministic rendering/memory proxy, not heap measurement',results},null,2));console.log(JSON.stringify(results));
} finally {await browser.close();await server.close();}
