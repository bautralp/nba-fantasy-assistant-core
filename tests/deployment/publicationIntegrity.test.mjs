import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const python = (...args) => execFileSync('python3', args, { stdio: 'pipe' });
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });

test('code push and daily refresh keep cached HTML runnable; missing entry JS cannot boot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pages-rollout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = join(directory, 'previous-build'), oldRelease = join(directory, 'old-release'), target = join(directory, 'public');
  await cp(resolve('dist'), previous, { recursive: true });
  let oldHtml = await readFile(join(previous, 'index.html'), 'utf8');
  // Real compiled application, synthetic prior content-addressed entry names; no captured user data.
  for (const match of [...oldHtml.matchAll(/(?:src|href)="(\/assets\/[^" ]+\.(?:js|css))"/g)]) {
    const path = match[1].slice(1), oldPath = path.replace('assets/', 'assets/previous-');
    await rename(join(previous, path), join(previous, oldPath));
    oldHtml = oldHtml.replaceAll('/' + path, '/' + oldPath);
  }
  await writeFile(join(previous, 'index.html'), oldHtml);
  python('scripts/prepare_pages.py', previous, oldRelease, '--source-sha', 'a'.repeat(40));
  await cp(oldRelease, target, { recursive: true });
  git(target, 'init', '-q'); git(target, 'remote', 'add', 'origin', 'https://github.com/nba-fantasy-assistant/nba-fantasy-assistant.github.io.git'); git(target, 'config', 'user.name', 'Synthetic publication'); git(target, 'config', 'user.email', 'tests@example.invalid');
  const commit = () => { git(target, 'add', '--all'); git(target, 'commit', '-qm', 'Synthetic publication'); };
  commit();
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const file = resolve(target, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(target + '/') || path.startsWith('/.git')) throw Error('path');
      const body = await readFile(file);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' })[extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  t.after(() => browser.close());
  const boot = async cached => {
    const page = await browser.newPage({ viewport: { width: 375, height: 900 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => errors.push(r.failure()?.errorText));
    page.on('response', r => { if (r.status() >= 400) errors.push(r.status()); });
    if (cached) await page.route(base + '/', r => r.fulfill({ contentType: 'text/html', body: oldHtml }));
    await page.goto(base);
    await page.getByRole('heading', { name: 'NBA Fantasy Assistant', exact: true }).waitFor();
    assert.equal(await page.locator('.main-cards button').count(), 3);
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(errors, []);
    await page.close();
  };
  for (const trigger of ['code-push', 'daily-refresh']) {
    const build = join(directory, trigger), release = join(directory, trigger + '-release');
    await cp(resolve('dist'), build, { recursive: true });
    if (trigger === 'daily-refresh') {
      // Same-length, valid JSON byte change: defeats any size/mtime quick-check without changing app data.
      const path = join(build, 'data/player-stats.json');
      const bytes = (await readFile(path, 'utf8')).trimEnd();
      await writeFile(path, bytes + ' ');
    }
    const sha = (trigger === 'code-push' ? 'b' : 'c').repeat(40);
    python('scripts/prepare_pages.py', build, release, '--source-sha', sha);
    python('scripts/stage_pages.py', release, target, '--source-sha', sha);
    assert.equal(JSON.parse(await readFile(join(target, 'deployment-manifest.json'), 'utf8')).sourceCommit, sha);
    await boot(false); await boot(true); commit();
  }
  const currentHtml = await readFile(join(target, 'index.html'), 'utf8');
  const entry = currentHtml.match(/<script[^>]*src="([^"]+\.js)"/)[1];
  const file = join(target, entry.slice(1)); await rename(file, file + '.missing');
  const page = await browser.newPage(), failures = [];
  page.on('response', r => { if (r.status() === 404) failures.push(new URL(r.url()).pathname); });
  await page.goto(base);
  await assert.rejects(page.getByRole('heading', { name: 'NBA Fantasy Assistant', exact: true }).waitFor({ timeout: 1000 }));
  assert.ok(failures.includes(entry), 'missing JS is a real 404 and never a successful application boot');
  await page.close();
});
