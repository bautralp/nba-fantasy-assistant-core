import { mkdir, writeFile } from 'node:fs/promises';

// Keep the failure's network/browser evidence; never retry or change assertions.
export function recordBrowserDiagnostics(t, page, browser, label) {
  const started = performance.now(), events = [];
  const record = (kind, detail) => events.push({ ms: Math.round(performance.now() - started), kind, detail });
  const relevant = request => new URL(request.url()).pathname.includes('/data/');
  page.on('request', r => { if (relevant(r)) record('request', r.url()); });
  page.on('response', r => { if (relevant(r.request())) record('response', { url: r.url(), status: r.status() }); });
  page.on('requestfinished', r => { if (relevant(r)) record('finished', r.url()); });
  page.on('requestfailed', r => record('failed', { url: r.url(), error: r.failure()?.errorText }));
  page.on('crash', () => record('crash', page.url()));
  page.on('pageerror', e => record('pageerror', e.message));
  page.on('console', m => { if (m.type() === 'error') record('console-error', m.text()); });
  browser.on('disconnected', () => record('browser-disconnected', null));
  t.after(async () => {
    const file = label.replace(/[^a-z0-9-]/gi, '-');
    await mkdir('artifacts/browser-diagnostics', { recursive: true });
    await writeFile(`artifacts/browser-diagnostics/${file}.json`, JSON.stringify({ test: t.name, events }, null, 2));
  });
}
