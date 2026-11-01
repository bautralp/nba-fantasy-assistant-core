import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { openSeason, expectedEvaluator, capture, noHorizontalScroll, poolEntries, espnRoute, realLeagueRaw } from '../helpers/seasonAnalysisUi.mjs';
import { rosterContributions } from '../../src/seasonAnalysis/teamInsights.ts';
import { bestDrop, simulateAddDrop } from '../../src/seasonAnalysis/addDrop.ts';
import { unsetGoals } from '../../src/seasonAnalysis/strategy.ts';
import { normalizePoolPage } from '../../src/infrastructure/espn/waiverPool.ts';
import { formatScore, formatValue } from '../../src/features/season/strategyPresentation.ts';
import { addDropSummary } from '../../src/features/season/waiverPresentation.ts';

let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
const region = p => p.getByRole('region', { name: 'Waiver Asistanı' });
const items = p => region(p).locator('.season-waiver-player');

function expected(raw, entries, goals = unsetGoals()) {
  const { league, evaluator, projections } = expectedEvaluator(raw), teamId = raw.teams[3].id;
  const team = rosterContributions(evaluator, league.teams, teamId, goals, projections);
  const pool = normalizePoolPage({ players: entries }, '2026-10-26T00:00:00Z').players;
  const projection = new Map(projections.map(p => [p.espnId, p]));
  const drop = team.players.filter(p => p.impact).at(-1);
  const args = add => ({ evaluator, teams: league.teams, baseline: team.baseline, slots: league.rosterSlots, myTeamId: teamId, add, goals, projection: projection.get(add.espnPlayerId) });
  const ranked = pool.map(add => ({ add, sim: simulateAddDrop({ ...args(add), dropId: drop.espnPlayerId }) })).filter(r => r.sim.impact)
    .sort((a, b) => b.sim.impact.strategyScore - a.sim.impact.strategyScore || a.add.espnPlayerId - b.add.espnPlayerId);
  return { team, ranked, drop, args, roster: league.teams.find(t => t.espnTeamId === teamId).roster };
}

for (const engine of (process.env.BROWSER_ENGINES || 'chromium').split(',')) {
  for (const width of [375, 1280]) test(`${engine}: Waiver ${width}px ranks the real-ID pool by computed team impact; read-only anonymous requests`, async t => {
    // 260 players: two 200-player pages, so paging is still exercised.
    const raw = realLeagueRaw(), entries = poolEntries(raw, 260), filters = [];
    const s = await openSeason(t, engine, width, { raw, routes: { espn: espnRoute(raw, entries, f => filters.push(f)) } });
    await s.enter(base, 'Waiver Asistanı'); const p = s.page; await items(p).first().waitFor();
    const e = expected(raw, entries);
    assert.ok(e.ranked.length >= 20);
    assert.deepEqual(await items(p).locator('.season-contribution-head strong').allInnerTexts(), e.ranked.slice(0, 20).map(r => r.add.name));
    assert.deepEqual(await items(p).locator('.season-contribution-score').allInnerTexts(), e.ranked.slice(0, 20).map(r => formatScore(r.sim.impact.strategyScore)));
    await region(p).getByText(`stratejine en az katkı veren ${e.drop.name}`, { exact: false }).waitFor();
    assert.deepEqual(filters.map(f => f.offset), [0, 200]); assert.ok(filters.every(f => f.limit === 200 && f.filterStatus.value.join() === 'FREEAGENT,WAIVERS'));
    assert.ok(s.requests.every(r => r.method === 'GET' && !r.headers.cookie && !r.headers.authorization), 'anonymous GET only');
    assert.equal(await noHorizontalScroll(p), true);
    assert.doesNotMatch(await region(p).innerText(), /SHA|revizyon|z-score|Standart|Genişletilmiş/);
    if (engine === 'chromium') await capture(p, `waiver-${width}`);
  });

  test(`${engine}: add/drop scenario uses the best drop, then any chosen drop; before/after equals the shared engine`, async t => {
    const raw = realLeagueRaw(), entries = poolEntries(raw);
    const s = await openSeason(t, engine, 1280, { raw, routes: { espn: espnRoute(raw, entries) } });
    await s.enter(base, 'Waiver Asistanı'); const p = s.page; await items(p).first().waitFor();
    const e = expected(raw, entries), first = e.ranked[0].add;
    await items(p).first().getByRole('button', { name: 'Ekle/bırak senaryosu' }).click();
    const panel = p.getByRole('region', { name: 'Ekle/bırak simülasyonu' }); await panel.locator('tbody tr').nth(8).waitFor();
    const best = bestDrop(e.args(first), e.roster.filter(x => x.placement !== 'ir').map(x => x.espnPlayerId));
    assert.equal(await panel.getByRole('combobox', { name: 'Bırakılacak oyuncu' }).inputValue(), String(best.dropId));
    const check = async sim => {
      for (const [i, c] of sim.impact.categories.entries()) {
        const cells = await panel.locator('tbody tr').nth(i).locator('td').allInnerTexts();
        assert.deepEqual(cells.slice(0, 2), [formatValue(c.category, c.before), formatValue(c.category, c.after)]);
        assert.equal(cells[3], `${c.beforeRank}. → ${c.afterRank}.`);
      }
      assert.equal(await panel.locator('p strong').first().innerText(), addDropSummary(sim.impact)[0]);
    };
    await check(best);
    const other = e.roster.find(x => x.placement !== 'ir' && x.espnPlayerId !== best.dropId);
    await panel.getByRole('combobox', { name: 'Bırakılacak oyuncu' }).selectOption(String(other.espnPlayerId));
    await check(simulateAddDrop({ ...e.args(first), dropId: other.espnPlayerId }));
    await capture(p, 'waiver-adddrop');
    await panel.getByRole('button', { name: 'Senaryoyu kapat' }).click();
    assert.equal(await p.getByRole('region', { name: 'Ekle/bırak simülasyonu' }).count(), 0);
    assert.ok(s.requests.every(r => r.method === 'GET'));
  });

  test(`${engine}: strategy edited in Waiver is the Team Analysis strategy; search, position and status filters`, async t => {
    const raw = realLeagueRaw(), entries = poolEntries(raw);
    const s = await openSeason(t, engine, 375, { raw, routes: { espn: espnRoute(raw, entries) } });
    await s.enter(base, 'Waiver Asistanı'); const p = s.page; await items(p).first().waitFor();
    await region(p).locator('summary').first().click();
    await p.getByRole('combobox', { name: '3PM hedefi' }).selectOption('top1');
    await p.getByRole('combobox', { name: 'REB hedefi' }).selectOption('punt');
    const goals = { ...unsetGoals(), '3PM': 'top1', REB: 'punt' }, e = expected(raw, entries, goals);
    assert.deepEqual(await items(p).locator('.season-contribution-head strong').allInnerTexts(), e.ranked.slice(0, 20).map(r => r.add.name));
    const name = e.ranked[5].add.name;
    await region(p).getByLabel('Oyuncu ara').fill(name.slice(0, 6));
    assert.ok((await items(p).locator('.season-contribution-head strong').allInnerTexts()).includes(name));
    await region(p).getByLabel('Oyuncu ara').fill('');
    await region(p).getByLabel('Pozisyon').selectOption('C');
    for (const text of await items(p).locator('.roster-positions').allInnerTexts()) assert.match(text, /\bC\b/);
    await region(p).getByLabel('Pozisyon').selectOption('');
    await region(p).getByLabel('Durum').selectOption('WAIVERS');
    for (const text of await items(p).locator('.roster-positions').allInnerTexts()) assert.match(text, /Waiver/);
    await p.getByRole('button', { name: '← Sezon içi ana menü' }).click();
    await p.getByRole('button', { name: 'Takım Analizi', exact: true }).click();
    await p.getByRole('combobox', { name: '3PM hedefi' }).waitFor();
    assert.equal(await p.getByRole('combobox', { name: '3PM hedefi' }).inputValue(), 'top1');
    assert.equal(await p.getByRole('combobox', { name: 'REB hedefi' }).inputValue(), 'punt');
  });

  test(`${engine}: owned players never shown as available; blocked pool request shows an error, no invented players`, async t => {
    const raw = realLeagueRaw(), entries = [...poolEntries(raw, 10)];
    const owned = raw.teams[0].roster.entries[0].playerPoolEntry.player;
    entries.unshift({ id: owned.id, onTeamId: 0, status: 'FREEAGENT', player: { ...owned, defaultPositionId: 1, eligibleSlots: owned.eligibleSlots } });
    entries.push({ id: 999999, onTeamId: 3, status: 'ONTEAM', player: { id: 999999, fullName: 'Owned elsewhere', proTeamId: 1, eligibleSlots: [0, 11] } });
    const s = await openSeason(t, engine, 375, { raw, routes: { espn: espnRoute(raw, entries) } });
    await s.enter(base, 'Waiver Asistanı'); const p = s.page; await items(p).first().waitFor();
    const names = await items(p).locator('.season-contribution-head strong').allInnerTexts();
    assert.ok(!names.includes(owned.fullName) && !names.includes('Owned elsewhere'));
    await region(p).getByText('Lig kadrosunda görünen 1 oyuncu listeden çıkarıldı', { exact: false }).waitFor();

    const blocked = await openSeason(t, engine, 375, { raw, routes: { espn: r => r.request().url().includes('kona_player_info') ? r.abort('failed') : r.fulfill({ json: raw }) } });
    await blocked.enter(base, 'Waiver Asistanı');
    await region(blocked.page).getByRole('alert').waitFor();
    assert.match(await region(blocked.page).getByRole('alert').innerText(), /CORS/);
    assert.equal(await items(blocked.page).count(), 0);
  });
}
