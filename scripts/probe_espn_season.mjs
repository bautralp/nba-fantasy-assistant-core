/** Manual read-only 17.2 probe. Prints aggregates only; never persist league/player payloads. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { parseLeagueInput, leagueUrl } from '../src/infrastructure/espn/client.ts';
import { normalizeLeague } from '../src/infrastructure/espn/normalize.ts';
const { leagueId, seasonId } = parseLeagueInput(process.argv[2] ?? '', Number(process.argv[3] ?? 2027));
const origin = 'https://nba-fantasy-assistant.github.io';
const controlled = process.argv.includes('--controlled-origin');
const args = [];
// Optional explicit environment proxy CA pin; CORS stays enabled and TLS is not globally disabled.
if (process.env.ESPN_PROXY_CA_PATH) {
  const pub = execFileSync('openssl', ['x509', '-in', process.env.ESPN_PROXY_CA_PATH, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: pub });
  const pin = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  args.push(`--ignore-certificate-errors-spki-list=${pin}`);
}
const browser = await chromium.launch({ headless: true, args, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}) });
const page = await browser.newPage(), cdp = await page.context().newCDPSession(page);
const report = { checkedAt: new Date().toISOString(), controlledDocument: controlled, origin, preflight: [], requests: [] };
await cdp.send('Network.enable');
cdp.on('Network.responseReceived', e => {
  if (e.type === 'Preflight') report.preflight.push({ status: e.response.status, headers: Object.fromEntries(Object.entries(e.response.headers).filter(([k]) => k.toLowerCase().startsWith('access-control-'))) });
});
try {
  if (controlled) await page.route(`${origin}/`, r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>ESPN CORS research</title>' }));
  await page.goto(origin, { timeout: 20_000 });
  if (await page.evaluate(() => location.origin) !== origin) throw Error('Unexpected origin');
  const base = leagueUrl(leagueId, seasonId).split('?')[0];
  for (const [name, suffix, headers] of [
    ['application', new URL(leagueUrl(leagueId, seasonId)).search, undefined],
    ['matchup', '?view=mMatchupScore', undefined], ['boxscore', '?view=mBoxscore', undefined],
    ['scoreboard', '?view=mScoreboard', undefined],
    ...[0, 25].map(offset => [`waiver-${offset}`, '?view=kona_player_info', { 'X-Fantasy-Filter': JSON.stringify({ players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit: 25, offset, sortPercOwned: { sortPriority: 1, sortAsc: false } } }) }]),
  ]) {
    const result = await page.evaluate(async ({ url, headers }) => {
      try {
        const r = await fetch(url, { method: 'GET', credentials: 'omit', headers, signal: AbortSignal.timeout(15_000) });
        const body = await r.text(); return { status: r.status, bytes: new TextEncoder().encode(body).length, body: JSON.parse(body) };
      } catch (e) { return { error: String(e) }; }
    }, { url: base + suffix, headers });
    const { body, ...metadata } = result;
    if (body && metadata.status === 200) {
      metadata.scheduleEntries = body.schedule?.length ?? null;
      metadata.weeks = [...new Set(body.schedule?.map(m => m.matchupPeriodId).filter(Number.isInteger) ?? [])];
      metadata.statSides = body.schedule?.flatMap(m => [m.home, m.away]).filter(s => s?.cumulativeScore?.scoreByStat != null).length ?? 0;
      metadata.playerCount = body.players?.length ?? null;
      metadata.statuses = body.players ? [...new Set(body.players.map(p => p.status))] : null;
      if (name === 'application') {
        const l = normalizeLeague(body, leagueId, seasonId);
        metadata.normalized = { teams: l.teams.length, daily: l.scoringPeriodId, weekly: l.matchupPeriodId, categories: l.scoring.categories.length };
      }
    }
    report.requests.push({ name, ...metadata });
  }
} catch (e) { report.error = String(e); }
finally { console.log(JSON.stringify(report, null, 2)); await browser.close(); }
