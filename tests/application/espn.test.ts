import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeLeague } from '../../src/infrastructure/espn/normalize.ts';
import { createEspnClient, leagueUrl, parseLeagueInput, ESPN_VIEWS } from '../../src/infrastructure/espn/client.ts';
import { matchEspnPlayer } from '../../src/features/season/identity.ts';
import { slotLabel } from '../../src/features/season/model.ts';
import { createSeasonSession } from '../../src/features/season/session.ts';
import type { SeasonState } from '../../src/features/season/session.ts';
const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/espn/public-league.json', import.meta.url), 'utf8'));
const response = () => new Response(JSON.stringify(fixture()));
const matchesCode = (code: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === code;
test('input, fixed host, repeated views and URL season validation', () => {
  assert.deepEqual(parseLeagueInput('https://fantasy.espn.com/basketball/league?leagueId=123&seasonId=2027', 2027), { leagueId: 123, seasonId: 2027 });
  const url = new URL(leagueUrl(123, 2027)); assert.equal(url.hostname, 'lm-api-reads.fantasy.espn.com'); assert.deepEqual(url.searchParams.getAll('view'), [...ESPN_VIEWS]);
  for (const input of ['-1', '0', '1.5', '9007199254740992', 'https://evil.com/basketball/?leagueId=123', 'https://fantasy.espn.com/football/?leagueId=123', 'https://fantasy.espn.com/basketball/?leagueId=123&seasonId=2026']) assert.throws(() => parseLeagueInput(input, 2027));
  assert.throws(() => parseLeagueInput('123', 2027.5)); assert.throws(() => parseLeagueInput('123', 2017));
});
test('normalizes actual rules without default assumptions; distinct daily/weekly IDs and unavailable scores', () => {
  const l = normalizeLeague(fixture(), 123, 2027); assert.equal(l.teams.length, 2); assert.equal(l.scoringPeriodId, 19); assert.equal(l.matchupPeriodId, 3); assert.equal(l.scoring.categories[2].label, 'ESPN stat 999');
  assert.equal(l.rosterSlots.find(s => s.slotId === 4)!.count, 2); assert.deepEqual(l.teams[0].roster!.map(p => p.placement), ['active', 'bench', 'ir', 'unknown', 'active']);
  assert.equal(l.matchups![0].away!.score, null); assert.deepEqual(l.matchups![0].home!.categoryStats, { '0': 225, '11': 19 });
  for (const scoringType of ['H2H_POINTS', 'ROTO', 'UNKNOWN']) { const f = fixture(); f.settings.scoringSettings.scoringType = scoringType; assert.equal(normalizeLeague(f, 123, 2027).scoring.analysisSupported, false); }
  const twelve = fixture(); twelve.teams.push(...Array.from({ length: 10 }, (_, i) => ({ id: i + 3, name: `Fixture ${i}` }))); assert.equal(normalizeLeague(twelve, 123, 2027).teams.length, 12);
});
test('missing optional data is explicitly unavailable; invalid required fields fail closed', () => {
  const f = fixture(); delete f.schedule; delete f.teams[0].roster; delete f.scoringPeriodId; delete f.status.currentMatchupPeriod;
  const l = normalizeLeague(f, 123, 2027); assert.equal(l.matchups, null); assert.equal(l.teams[0].roster, null); assert.equal(l.scoringPeriodId, null); assert.equal(l.matchupPeriodId, null);
  for (const mutate of [(f: any) => delete f.settings, (f: any) => delete f.teams, (f: any) => f.teams[0].roster.entries[0].playerPoolEntry.player.id = null, (f: any) => f.teams.push(f.teams[0]), (f: any) => f.teams[0].roster.entries.push(f.teams[0].roster.entries[0]), (f: any) => f.schedule[0].away.teamId = 999, (f: any) => f.settings.rosterSettings.lineupSlotCounts[0] = -1]) { const f = fixture(); mutate(f); assert.throws(() => normalizeLeague(f, 123, 2027), matchesCode('validation')); }
  assert.throws(() => normalizeLeague(fixture(), 123, 2026), matchesCode('validation'));
  const privateLeague = fixture(); privateLeague.settings.isPublic = false; assert.throws(() => normalizeLeague(privateLeague, 123, 2027), matchesCode('private'));
});
test('exact numeric identity; unknown and duplicate IDs never silently match by name', () => {
  const players = [{ id: 'a', name: 'Different name', providerIds: { espn: '101' } }, { id: 'b', name: 'Fixture Beta', providerIds: { espn: '999' } }];
  assert.deepEqual(matchEspnPlayer(101, players), { status: 'matched', playerId: 'a' }); assert.deepEqual(matchEspnPlayer(102, players), { status: 'unmatched' });
  assert.deepEqual(matchEspnPlayer(101, [...players, { ...players[0], id: 'duplicate' }]), { status: 'ambiguous' }); assert.deepEqual(matchEspnPlayer(NaN, players), { status: 'invalid' });
});
test('anonymous GET only, cache, manual refresh, bounded rate', async () => {
  let calls = 0, clock = 100000;
  const c = createEspnClient({ now: () => clock, fetcher: async (_url, init) => { calls++; assert.equal(init!.method, 'GET'); assert.equal(init!.credentials, 'omit'); assert.equal(init!.headers, undefined); assert.equal(init!.redirect, 'error'); return response(); } });
  const a = await c.load('123', 2027); assert.equal(await c.load('123', 2027), a); assert.equal(calls, 1); await assert.rejects(c.load('123', 2027, { refresh: true }), matchesCode('rate-limit'));
  clock += 2100; await c.load('123', 2027, { refresh: true }); assert.equal(calls, 2);
});
test('private/not-found/rate-limit/response errors; bounded server retries; network errors', async () => {
  for (const [status, code] of [[401, 'private'], [403, 'private'], [404, 'not-found'], [429, 'rate-limit'], [400, 'response']] as const) { let calls = 0; const c = createEspnClient({ fetcher: async () => { calls++; return new Response('{}', { status }); } }); await assert.rejects(c.load('123', 2027), matchesCode(code)); assert.equal(calls, 1); }
  let calls = 0; const c = createEspnClient({ fetcher: async () => { calls++; return new Response('{}', { status: 503 }); } }); await assert.rejects(c.load('123', 2027), matchesCode('response')); assert.equal(calls, 2);
  await assert.rejects(createEspnClient({ fetcher: async () => { throw new TypeError('Failed to fetch'); } }).load('123', 2027), matchesCode('network'));
  for (const [body, code] of [['not json', 'response'], ['{}', 'validation']] as const) await assert.rejects(createEspnClient({ fetcher: async () => new Response(body) }).load('123', 2027), matchesCode(code));
});
test('timeout covers fetch and body; response size limit covers streamed bytes', async () => {
  const c = createEspnClient({ timeoutMs: 5, fetcher: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))); }) }); await assert.rejects(c.load('123', 2027), matchesCode('timeout'));
  await assert.rejects(createEspnClient({ maxBytes: 10, fetcher: async () => new Response('x'.repeat(11)) }).load('123', 2027), matchesCode('size'));
  await assert.rejects(createEspnClient({ maxBytes: 10, fetcher: async () => new Response('{}', { headers: { 'content-length': '11' } }) }).load('123', 2027), matchesCode('size'));
});
test('changing league during refresh cannot overwrite new selection; failed refresh preserves last success', async () => {
  let resolveOld!: (l: ReturnType<typeof normalizeLeague>) => void; let state: SeasonState | undefined;
  const l = normalizeLeague(fixture(), 123, 2027), other = { ...l, leagueId: 456, name: 'Other' };
  const session = createSeasonSession(async input => input === 'old' ? new Promise(resolve => { resolveOld = resolve; }) : input === 'fail' ? Promise.reject(new Error('failed')) : other, s => { state = s; });
  const old = session.connect('old', 2027); await session.connect('new', 2027); resolveOld(l); await old; assert.equal(state!.league, other);
  await session.connect('fail', 2027, true); assert.equal(state!.league, other); assert.equal(state!.stale, true); assert.ok(state!.error);
});
test('timeout also cancels a response whose body stalls', async () => {
  const c = createEspnClient({ timeoutMs: 5, fetcher: async (_url, init) => new Response(new ReadableStream({ start(controller) { init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted body'))); } })) });
  await assert.rejects(c.load('123', 2027), matchesCode('timeout'));
});
test('429 cooldown prevents more network requests, with Retry-After respected', async () => {
  let clock = 100000, calls = 0;
  const c = createEspnClient({ now: () => clock, fetcher: async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '10' } }); } });
  await assert.rejects(c.load('123', 2027), matchesCode('rate-limit')); clock += 9000;
  await assert.rejects(c.load('123', 2027), matchesCode('rate-limit')); assert.equal(calls, 1);
  clock += 1001; await assert.rejects(c.load('123', 2027), matchesCode('rate-limit')); assert.equal(calls, 2);
});

test('slot labels stay aligned with the existing reviewed FBA catalog mapping', () => {
  const mapping = JSON.parse(readFileSync(new URL('../../scripts/fba-slot-mapping-2027.json', import.meta.url), 'utf8'));
  for (const [id, label] of Object.entries(mapping.slots)) assert.equal(slotLabel(Number(id)).toUpperCase(), label);
  assert.equal(slotLabel(19), 'ESPN slot 19');
});
test('real adapter plus session: league changes during an outstanding refresh keep newest result', async () => {
  let clock = 100000, resolveOld!: (r: Response) => void, state: SeasonState | undefined;
  const next = fixture(); next.id = 456; next.settings.name = 'New fixture league';
  const client = createEspnClient({ now: () => clock, fetcher: async url => String(url).includes('/123?') ? new Promise(resolve => { resolveOld = resolve; }) : new Response(JSON.stringify(next)) });
  const session = createSeasonSession((i, s, o) => client.load(i, s, o), s => { state = s; });
  const first = session.connect('123', 2027, true); clock += 2001;
  await session.connect('456', 2027); resolveOld(response()); await first;
  assert.equal(state!.league!.leagueId, 456); assert.equal(state!.error, null); assert.equal(state!.stale, false);
  assert.equal((await client.load('456', 2027)).name, 'New fixture league');
});
test('observed category response shape: provider W/L/T, absent per-stat scores, zero rank sentinel', () => {
  // Hand-authored synthetic values and identities; only schema differences reflect the live probe.
  const raw = JSON.parse(readFileSync(new URL('../fixtures/espn/category-response-shape.json', import.meta.url), 'utf8'));
  const l = normalizeLeague(raw, 789, 2027);
  assert.equal(l.scoring.type, 'H2H_MOST_CATEGORIES'); assert.equal(l.scoring.categories.length, 9);
  assert.equal(l.teams[0].rank, null); assert.equal(l.scoringPeriodId, 23); assert.equal(l.matchupPeriodId, 4);
  assert.deepEqual(l.matchups![0].home!.categoryRecord, { wins: 5, losses: 2, ties: 2 });
  assert.deepEqual(l.matchups![1].home!.categoryRecord, { wins: 0, losses: 0, ties: 0 });
  assert.equal(l.matchups![0].home!.score, 0); assert.equal(l.matchups![0].home!.categoryStats, null);
  assert.equal(l.matchups![1].away!.categoryRecord, null);
  assert.equal(l.teams[0].roster![0].placement, 'active');
  // Team season valuesByStat and per-slot values must never masquerade as matchup stats.
  raw.schedule[0].home.cumulativeScore.statBySlot = { '0': { '0': 987 } };
  raw.schedule[0].home.cumulativeScore.scoreByStat = null;
  assert.equal(normalizeLeague(raw, 789, 2027).matchups![0].home!.categoryStats, null);
});
