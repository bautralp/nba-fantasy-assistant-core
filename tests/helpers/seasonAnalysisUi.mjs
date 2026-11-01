import { unifiedScenario, unifiedStandard, unifiedSchedule } from './unifiedScenario.ts';
/** Shared browser harness for Team Analysis / Waiver / Trade. ESPN responses are the
 * pinned anonymised real league; standard and schedule are published, unified scenario is the replayed
 * files. Nothing is fetched from the network. */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { adaptCentralRos, parseAnalysisSchedule } from '../../src/seasonAnalysis/centralAdapter.ts';
import { createLeagueEvaluator } from '../../src/seasonAnalysis/analyzeLeague.ts';
import { normalizeLeague } from '../../src/infrastructure/espn/normalize.ts';
const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
export const ros = unifiedStandard;
export const schedule = unifiedSchedule;
export const scenario = unifiedScenario;
const real = read('../fixtures/season-analysis/public-league-normalized.json');

/** Raw ESPN-shaped league built from the normalized real fixture (IDs, slots, ownership kept). */
export function realLeagueRaw() {
  return { id: 789, seasonId: 2027, scoringPeriodId: 1, status: { currentMatchupPeriod: 1 },
    settings: { name: 'Gerçek lig kadrosu · anonimleştirilmiş kayıt', isPublic: true,
      scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', allowOutOfPositionScoring: false, scoringItems: [19, 20, 17, 6, 3, 2, 1, 11, 0].map(statId => ({ statId, points: 1, isReverseItem: statId === 11 })) },
      rosterSettings: { lineupLocktimeType: 'INDIVIDUAL_GAME', rosterLocktimeType: 'FIRSTGAME_SCORINGPERIOD', lineupSlotStatLimits: {}, lineupSlotCounts: Object.fromEntries(real.rosterSlots.map(s => [s.slotId, s.count])) } },
    teams: real.teams.map(t => ({ id: t.espnTeamId, name: t.name, roster: { entries: t.roster.map(v => ({ playerId: v.espnPlayerId, lineupSlotId: v.lineupSlotId, playerPoolEntry: { player: { id: v.espnPlayerId, fullName: v.name, proTeamId: v.proTeamId, eligibleSlots: v.eligibleSlotIds } } })) } })) };
}
/** Exactly the client pipeline: unified scenario projections + the published schedule. */
export function expectedEvaluator(raw = realLeagueRaw()) {
  const parsed = parseAnalysisSchedule(schedule), adapted = adaptCentralRos(scenario.projection, parsed);
  const league = normalizeLeague(raw, raw.id, 2027);
  const evaluator = createLeagueEvaluator({ league, projections: adapted.projections, schedule: parsed, asOf: scenario.asOf, dataUpdatedAt: scenario.projection.generatedAt, datasetRevision: 'test', lineupPolicy: 'daily-max-games' });
  return { league, evaluator, projections: adapted.projections };
}
export async function openSeason(t, engine, width, { raw = realLeagueRaw(), teamIndex = 3, routes = {} } = {}) {
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'tr-TR' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  const requests = []; page.on('request', r => { if (r.url().includes('espn.com')) requests.push({ method: r.method(), url: r.url(), headers: r.headers() }); });
  await page.clock.install({ time: new Date(Date.parse(schedule.retrievedAt) + 3600000) });
  await page.route('**/data/player-projections.json', r => routes.projections ? routes.projections(r) : r.fulfill({ json: ros }));
  await page.route('**/data/analysis-schedule.json', r => r.fulfill({ json: schedule }));
  await page.route('**/data/projection-scenarios.json', r => r.fulfill({ json: scenario }));
  await page.route('https://lm-api-reads.fantasy.espn.com/**', r => routes.espn ? routes.espn(r) : r.fulfill({ json: raw }));
  return { page, requests, raw, async enter(base, module) {
    await page.goto(base); await page.getByRole('button', { name: /Sezon İçi Asistanı Lig/ }).click();
    await page.getByLabel('ESPN League ID veya lig URL’si').fill(String(raw.id)); await page.getByRole('button', { name: 'Ligi bağla', exact: true }).click();
    await page.getByRole('button', { name: raw.teams[teamIndex].name, exact: true }).click();
    if (module) await page.getByRole('button', { name: module, exact: true }).click();
  } };
}
export const capture = async (p, name) => {
  if (!process.env.SEASON_CAPTURE_DIR) return;
  mkdirSync(process.env.SEASON_CAPTURE_DIR, { recursive: true });
  await p.screenshot({ path: join(process.env.SEASON_CAPTURE_DIR, `${name}.png`), fullPage: true });
};
export const noHorizontalScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const SLOT = { PG: [0, 5, 11], SG: [1, 5, 7, 8, 11], SF: [2, 6, 7, 8, 11], PF: [3, 6, 9, 11], C: [4, 9, 10, 11] };
/** ESPN-shaped kona_player_info pool built from real unrostered player IDs/teams in the
 * published scenario file. Hand-built response: real IDs, not a live ESPN payload. */
export function poolEntries(raw = realLeagueRaw(), count = 60) {
  const owned = new Set(raw.teams.flatMap(t => t.roster.entries.map(e => e.playerId)));
  return scenario.projection.players.filter(p => p.status === 'available' && p.rosGP > 0 && p.teamId && p.eligibility?.status === 'verified' && !owned.has(Number(p.id)) && p.eligibility.positions?.length)
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || Number(a.id) - Number(b.id)).slice(0, count)
    .map((p, i) => ({ id: Number(p.id), onTeamId: 0, status: i % 7 === 3 ? 'WAIVERS' : 'FREEAGENT', ...(i % 7 === 3 ? { waiverProcessDate: Date.parse('2026-10-28T07:00:00Z') } : {}),
      player: { id: Number(p.id), fullName: p.name, proTeamId: p.teamId, defaultPositionId: ['PG', 'SG', 'SF', 'PF', 'C'].indexOf(p.eligibility.positions[0]) + 1,
        eligibleSlots: [...new Set(p.eligibility.positions.flatMap(x => SLOT[x] ?? []))].sort((a, b) => a - b).concat([12, 13]), injuryStatus: 'ACTIVE', ownership: { percentOwned: 60 - i / 2 } } }));
}
/** Route ESPN: league requests get the league, kona requests get the filtered page. */
export function espnRoute(raw, entries, onPool = () => {}) {
  return async route => {
    const req = route.request();
    if (!req.url().includes('kona_player_info')) return route.fulfill({ json: raw });
    const filter = JSON.parse(req.headers()['x-fantasy-filter']).players; onPool(filter, req);
    return route.fulfill({ json: { players: entries.slice(filter.offset, filter.offset + filter.limit) } });
  };
}
