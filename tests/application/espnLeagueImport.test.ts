import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLeague } from '../../src/infrastructure/espn/normalize.ts';
import { createEspnClient } from '../../src/infrastructure/espn/client.ts';
import { checkDraftSupport, espnImportError, settingsFromEspn } from '../../src/application/espnLeagueImport.ts';
import { applyLeagueSettings, blankLeagueSettings } from '../../src/application/leagueSetup.ts';
import { espnLeague, STANDARD_SLOTS, NINE_STAT_IDS, DEFAULT_PICK_ORDER, type LeagueOptions } from '../helpers/espnLeagueFixture.ts';

const league = (options: LeagueOptions = {}) => normalizeLeague(espnLeague(options), 123, 2027);
const reasons = (options: LeagueOptions) => { const r = checkDraftSupport(league(options)); assert.equal(r.ok, false); return r.ok ? [] : r.reasons; };

test('a 10-team, 13-player, standard 9CAT league is supported and fills the form', () => {
  const support = checkDraftSupport(league());
  assert.equal(support.ok, true);
  if (!support.ok) return;
  assert.equal(support.name, 'Fixture ESPN League');
  assert.deepEqual(support.teams.map(t => t.espnTeamId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(support.notes, []);
  const blank = { ...blankLeagueSettings(), season: '2026-27' };
  const settings = settingsFromEspn(support, blank);
  assert.equal(settings.name, 'Fixture ESPN League');
  assert.equal(settings.season, '2026-27');
  assert.deepEqual(settings.teams.map(t => t.id), blank.teams.map(t => t.id), 'workspace IDs stay local UUIDs');
  assert.deepEqual(settings.teams.map(t => t.name), support.teams.map(t => t.name));
  const nameOf = (id: string) => settings.teams.find(t => t.id === id)!.name;
  assert.deepEqual(settings.draftOrder.map(nameOf), DEFAULT_PICK_ORDER.map(id => `ESPN Takım ${id}`), 'first-round order comes from ESPN pickOrder');
  assert.equal(settings.userTeamId, '', 'the user still chooses their own team');
  assert.equal(applyLeagueSettings(settings, null).ok, false, 'no league is created until a team is chosen');
  const created = applyLeagueSettings({ ...settings, userTeamId: settings.teams[3].id }, null);
  assert.equal(created.ok, true);
  if (created.ok) assert.deepEqual(created.value.teams.map(t => t.name), support.teams.map(t => t.name));
  for (const type of ['H2H_CATEGORY', 'H2H_EACH_CATEGORY']) assert.equal(checkDraftSupport(league({ scoringType: type })).ok, true, type);
});

test('unsupported settings are named one by one', () => {
  assert.match(reasons({ teams: 12 })[0], /Ligin 12 takımlı/);
  assert.match(reasons({ teams: 8 })[0], /Ligin 8 takımlı/);
  assert.match(reasons({ slots: { ...STANDARD_SLOTS, 12: 4 } })[0], /takım başına 14 oyuncu var \(IR hariç\)/);
  assert.equal(checkDraftSupport(league({ slots: { ...STANDARD_SLOTS, 13: 3 } })).ok, true, 'IR spots do not count toward the 13');
  assert.match(reasons({ scoringType: 'H2H_POINTS' })[0], /puan \(points\)/);
  assert.match(reasons({ scoringType: 'ROTO' })[0], /Roto sistemiyle/);
  assert.match(reasons({ scoringType: 'SOMETHING_NEW' })[0], /skor sistemi tanınmadı \(SOMETHING_NEW\)/);
  assert.match(reasons({ statIds: [...NINE_STAT_IDS, 13] })[0], /10 kategori var; farklı: FGM/);
  assert.match(reasons({ statIds: NINE_STAT_IDS.filter(id => id !== 20) })[0], /8 kategori var; eksik: FT%/);
  assert.match(reasons({ statIds: NINE_STAT_IDS.map(id => id === 20 ? 21 : id) })[0], /eksik: FT%; farklı: 3P%/);
  const several = reasons({ teams: 12, scoringType: 'H2H_POINTS' });
  assert.equal(several.length, 2);
});

test('a different 13-slot layout is allowed with an explanatory note', () => {
  const support = checkDraftSupport(league({ slots: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 11: 5, 12: 3, 13: 1 } }));
  assert.equal(support.ok, true);
  if (support.ok) assert.match(support.notes[0], /kadro slotları/);
});

test('each failure has its own message; aborted requests stay silent', () => {
  const codes = ['input', 'not-found', 'private', 'rate-limit', 'timeout', 'network', 'validation'];
  const messages = codes.map(espnImportError);
  assert.equal(new Set(messages).size, codes.length);
  assert.match(espnImportError('private')!, /gizli \(private\)/);
  assert.match(espnImportError('not-found')!, /bulunamadı/);
  assert.match(espnImportError('network')!, /ulaşılamadı/);
  assert.equal(espnImportError('aborted'), null);
  assert.equal(espnImportError(undefined), espnImportError('validation'));
});

test('the existing read-only client maps HTTP results to those codes', async () => {
  const code = async (fetcher: typeof fetch, input = '123') => {
    try { await createEspnClient({ fetcher, minIntervalMs: 0 }).load(input, 2027); return 'ok'; } catch (e) { return (e as { code: string }).code; }
  };
  const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  assert.equal(await code(respond(200, espnLeague())), 'ok');
  assert.equal(await code(respond(404)), 'not-found');
  assert.equal(await code(respond(401)), 'private');
  assert.equal(await code(respond(200, espnLeague({ isPublic: false }))), 'private');
  assert.equal(await code((async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch), 'network');
  let called = false;
  assert.equal(await code((async () => { called = true; return new Response('{}'); }) as typeof fetch, 'abc'), 'input');
  assert.equal(called, false, 'an invalid ID never reaches ESPN');
  const requests: RequestInit[] = [];
  await code((async (_url: string, init: RequestInit) => { requests.push(init); return new Response(JSON.stringify(espnLeague())); }) as unknown as typeof fetch);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].credentials, 'omit');
});

test('ESPN draft order: missing or inconsistent orders fall back to team order with a note; auction is flagged', () => {
  const fallback = (draft: LeagueOptions['draft']) => {
    const support = checkDraftSupport(league({ draft }));
    assert.equal(support.ok, true);
    if (!support.ok) throw new Error();
    assert.equal(support.draftOrder, null);
    assert.match(support.notes.join(' '), /draft sırası henüz belirlenmemiş/);
    const settings = settingsFromEspn(support, { ...blankLeagueSettings(), season: '2026-27' });
    assert.deepEqual(settings.draftOrder, settings.teams.map(t => t.id), 'falls back to ESPN team-number order');
  };
  fallback(null);
  fallback({ type: 'SNAKE', pickOrder: [] });
  fallback({ type: 'SNAKE', pickOrder: DEFAULT_PICK_ORDER.slice(0, 9) });
  fallback({ type: 'SNAKE', pickOrder: [...DEFAULT_PICK_ORDER.slice(0, 9), 7] });
  fallback({ type: 'SNAKE', pickOrder: [...DEFAULT_PICK_ORDER.slice(0, 9), 99] });
  fallback({ type: 'SNAKE', pickOrder: 'not-a-list' });
  const auction = checkDraftSupport(league({ draft: { type: 'AUCTION', pickOrder: DEFAULT_PICK_ORDER } }));
  assert.equal(auction.ok, true);
  if (auction.ok) { assert.deepEqual(auction.draftOrder, DEFAULT_PICK_ORDER); assert.match(auction.notes.join(' '), /açık artırma \(auction\)/); }
  const normalized = league();
  assert.deepEqual(normalized.draftSettings, { type: 'SNAKE', pickOrder: DEFAULT_PICK_ORDER });
});
