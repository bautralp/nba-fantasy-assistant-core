import { unifiedScenario, unifiedStandard } from '../helpers/unifiedScenario.ts';
import { parseScenarioSnapshot } from '../../src/projections/scenarioSnapshot.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

// Strict static hosting: archived happy paths use their own local page and complete pair.
async function serveBuild(t) {
  const root = resolve(process.env.PAGES_TEST_DIST || 'dist');
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
      if (!path.startsWith(root + '/')) throw Error('path');
      const body = await readFile(path);
      res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'})[extname(path)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('built Pages site: exact production bytes, Actual periods and the actual ROS pair (no archive substitution)', async t => {
  const base = process.env.PAGES_TEST_URL || await serveBuild(t);
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || undefined});
  t.after(() => browser.close());
  const page = await browser.newPage({locale:'tr-TR', viewport:{width:375,height:900}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push(r.url()));
  page.on('response', r => { if(r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  const entry = await page.goto(base);
  assert.equal(entry.status(), 200);
  await page.getByRole('heading', {name:'NBA Fantasy Assistant',exact:true}).waitFor();
  const expectedSha = process.env.PAGES_EXPECTED_SHA || execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
  const manifest = await page.request.get(`${base}/deployment-manifest.json`);
  assert.equal(manifest.status(), 200);
  const expectedManifest = JSON.parse(await readFile(resolve(process.env.PAGES_TEST_DIST || 'dist', 'deployment-manifest.json'), 'utf8'));
  assert.equal(expectedManifest.schemaVersion, 2);
  assert.equal(expectedManifest.sourceCommit, expectedSha);
  assert.deepEqual(await manifest.json(), expectedManifest);
  const sha256 = b => createHash('sha256').update(b).digest('hex');
  assert.equal(sha256(await entry.body()), expectedManifest.files['index.html'], 'canonical root HTML belongs to this release');
  for (const [path, expected] of Object.entries(expectedManifest.files).filter(([p]) => /\.(?:html|js|css)$/.test(p))) {
    const asset = await page.request.get(base + '/' + path);
    assert.equal(asset.status(), 200, path);
    assert.equal(sha256(await asset.body()), expected, path);
    if (path.endsWith('.js')) assert.match(asset.headers()['content-type'], /(?:application|text)\/javascript/);
    if (path.endsWith('.css')) assert.match(asset.headers()['content-type'], /text\/css/);
  }
  const hash = b => createHash('sha256').update(b).digest('hex');
  for (const name of ['player-stats.json','player-projections.json','fantasy-positions.json','current-rosters.json','projection-refresh-status.json','analysis-schedule.json','projection-scenarios.json']) {
    const r = await page.request.get(`${base}/data/${name}`);
    assert.equal(r.status(), 200);
    assert.equal(hash(await r.body()), expectedManifest.files[`data/${name}`]);
  }
  for (const path of ['/fonts/michroma-latin.woff2','/legacy/v3.3.html','/.nojekyll']) {
    assert.equal((await page.request.get(base + path)).status(), 200, path);
  }
  assert.equal((await page.request.get(base + '/missing-stage16-file')).status(), 404);
  await page.getByRole('button', {name:'Oyuncu Sıralamaları Oyuncu sıralamalarını',exact:false}).click();
  for (const period of ['last7','last14','last30','season','lastSeason']) {
    await page.getByLabel('Dönem',{exact:true}).selectOption(period);
    await page.getByRole('region',{name:'SportsDataverse oyuncu istatistikleri',exact:true}).getByRole('table').waitFor();
  }
  await page.getByLabel('Dönem',{exact:true}).selectOption('projected');
  const published = await (await page.request.get(`${base}/data/projection-scenarios.json`)).json();
  const projection = page.getByRole('region',{name:'ROS projeksiyonları',exact:true});
  if (published.modelVersion === 'scenario-9cat/1' && !process.env.PAGES_TEST_URL) {
    // The checked-in transition data must fail closed. Never pair a dated test
    // candidate with today's Standard or replace any production response here.
    await projection.getByRole('alert').waitFor();
    assert.equal(await projection.getByRole('table').count(),0,'legacy scenario is never a silent Standard fallback');
  } else {
    assert.equal(published.modelVersion,'unified-ros/2','production requires an actual compatible v2 publication');
    const response = await page.request.get(`${base}/data/player-projections.json`);
    const bytes = await response.body(), standard = JSON.parse(bytes.toString());
    parseScenarioSnapshot(published,standard);
    assert.equal(published.inputRevision.standardSHA256,hash(bytes));
    await page.getByRole('region',{name:'Projected oyuncu sıralamaları',exact:true}).getByRole('table').waitFor();
    await projection.getByLabel('Oyuncu adıyla ara').fill('Nikola Jokic');
    const row = projection.locator('tbody tr');
    const expected = published.projection.players.find(p=>p.name==='Nikola Jokic');
    assert.ok(expected && expected.status==='available');
    assert.equal(await row.count(),1);
    assert.equal(await row.locator('td').nth(5).innerText(),expected.minutes.toFixed(1));
  }

  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});


test('built bundle renders the explicitly archived October 25 v2 pair independently of current production', async t => {
  const base=await serveBuild(t);
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:900}});
  parseScenarioSnapshot(unifiedScenario,unifiedStandard);
  assert.equal(unifiedScenario.standardGeneratedAt,'2026-10-25T14:50:06.448491+00:00');
  await page.route('**/data/player-projections.json',r=>r.fulfill({json:unifiedStandard}));
  await page.route('**/data/projection-scenarios.json',r=>r.fulfill({json:unifiedScenario}));
  await page.goto(base);
  await page.getByRole('button',{name:'Oyuncu Sıralamaları Oyuncu sıralamalarını',exact:false}).click();
  await page.getByLabel('Dönem',{exact:true}).selectOption('projected');
  const projection=page.getByRole('region',{name:'ROS projeksiyonları',exact:true});
  await projection.getByRole('table').waitFor();
  await projection.getByLabel('Oyuncu adıyla ara').fill('Nikola Jokic');
  const row=projection.locator('tbody tr');
  assert.equal(await row.count(),1);
  assert.equal(await row.locator('td').nth(5).innerText(),unifiedStandard.players.find(p=>p.id==='3112335').minutes.toFixed(1));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});
