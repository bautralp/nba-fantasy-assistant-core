/** Local production-build shell smoke only; no live provider or production site requests. */
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {enterDraft} from '../helpers/workspaceUi.mjs';
const root=resolve('dist');
const server=createServer((req,res)=>{
 const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
 if(!path.startsWith(root+'/') && path!==root){res.writeHead(403);res.end();return;}
 const file=path===root?resolve(root,'index.html'):path;
 if(!existsSync(file)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const width of [375,1280]){
  const context=await browser.newContext({viewport:{width,height:900},locale:'tr-TR'});
  await context.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await enterDraft(page);
  assert.equal(await page.locator('#page-heading-draft').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'PASS',width,scope:'actual production build; manual draft startup only; production datasets absent; external requests blocked'}));
  await context.close();
 }
}finally{await browser?.close();await new Promise(r=>server.close(r));}
