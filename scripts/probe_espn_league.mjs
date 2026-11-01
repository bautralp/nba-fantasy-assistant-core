/** Manual read-only browser probe. No cookies, custom headers, roster data or auth. */
import { chromium } from 'playwright';
import { normalizeLeague } from '../src/infrastructure/espn/normalize.ts';
import { parseLeagueInput, leagueUrl } from '../src/infrastructure/espn/client.ts';
const input = process.argv[2], season = Number(process.argv[3] ?? 2027);
if (!input) throw new Error('Usage: node --experimental-strip-types scripts/probe_espn_league.mjs LEAGUE_ID [SEASON] [--controlled-origin]');
const { leagueId } = parseLeagueInput(input, season);
const origin = 'https://nba-fantasy-assistant.github.io';
const controlled = process.argv.includes('--controlled-origin');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}) });
const page = await browser.newPage();
const failures = []; page.on('requestfailed', r => failures.push({ url: new URL(r.url()).origin, reason: r.failure()?.errorText }));
const report = { checkedAt: new Date().toISOString(), origin, controlledDocument: controlled, navigation: null, requests: [], failures };
try {
  // This replaces only the document, never the ESPN responses. It does not test deployed app CSP.
  if (controlled) await page.route(`${origin}/`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controlled ESPN CORS probe</title>' }));
  await page.goto(origin, { timeout: 20_000 });
  report.navigation = { origin: await page.evaluate(() => location.origin), title: await page.title() };
  if (report.navigation.origin !== origin) throw new Error('Unexpected document origin');
  for (const views of [['mSettings', 'mTeam', 'mStatus'], ...['mRoster', 'mMatchupScore', 'mStandings'].map(v => ['mSettings', 'mTeam', 'mStatus', v]), ['mSettings', 'mTeam', 'mRoster', 'mMatchupScore', 'mStatus', 'mStandings']]) {
    const url = leagueUrl(leagueId, season, views);
    const result = await page.evaluate(async ({url,views}) => {
      try { const r = await fetch(url, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(15_000) }); const body = await r.json(); return { views, status: r.status, readable: true, body }; }
      catch(e) { return { views, readable: false, error: String(e) }; }
    }, {url,views});
    // Raw JSON stays in memory; never print or persist team names, rosters or members.
    const { body, ...metadata } = result;
    if (metadata.status === 200) {
      try {
        const league = normalizeLeague(body, leagueId, season);
        metadata.normalizer = { accepted: true, teams: league.teams.length, scoringType: league.scoring.type,
          categories: league.scoring.categories.length, scoringPeriodId: league.scoringPeriodId,
          matchupPeriodId: league.matchupPeriodId, rosterPlayers: league.teams.reduce((n, t) => n + (t.roster?.length ?? 0), 0),
          scheduleEntries: league.matchups?.length ?? null };
      } catch (e) { metadata.normalizer = { accepted: false, error: e.message }; }
    }
    report.requests.push(metadata);
  }
} catch(e) { report.error = String(e); }
finally { console.log(JSON.stringify(report, null, 2)); await browser.close(); }
