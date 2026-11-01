import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { openSeason, expectedEvaluator, capture, noHorizontalScroll, realLeagueRaw } from '../helpers/seasonAnalysisUi.mjs';
import { emptyScenario, moveScenario, simulateTrades } from '../../src/seasonAnalysis/trade.ts';
import { unsetGoals } from '../../src/seasonAnalysis/strategy.ts';
import { formatValue } from '../../src/features/season/strategyPresentation.ts';
import { tradeScenarioKey } from '../../src/features/season/useTradeScenario.ts';

let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
const region = p => p.getByRole('region', { name: 'Takas Asistanı' });
const move = (p, name, target) => p.getByRole('combobox', { name: `${name} hedefi` }).selectOption({ label: target });
const firstRegular = team => team.roster.entries.find(e => e.lineupSlotId !== 13);

for (const engine of (process.env.BROWSER_ENGINES || 'chromium').split(',')) {
  for (const width of [375, 1280]) test(`${engine}: Trade ${width}px two-team swap shows both teams before/after from the shared engine`, async t => {
    const raw = realLeagueRaw(), mine = raw.teams[3], partner = raw.teams.find(x => x.id !== mine.id);
    const s = await openSeason(t, engine, width, { raw }); await s.enter(base, 'Takas Asistanı');
    const p = s.page; await region(p).locator('.season-trade-team').first().waitFor();
    const give = firstRegular(mine).playerPoolEntry.player, get = firstRegular(partner).playerPoolEntry.player;
    await move(p, give.fullName, `→ ${partner.name}`); await move(p, get.fullName, `→ ${mine.name}`);
    await region(p).getByRole('button', { name: 'Takasın etkisini gör' }).click();
    const result = p.getByRole('region', { name: 'Takas sonucu' }); await result.locator('table').nth(1).waitFor();
    const { league, evaluator } = expectedEvaluator(raw);
    let sc = emptyScenario();
    for (const m of [{ playerId: give.id, sourceTeamId: mine.id, target: partner.id }, { playerId: get.id, sourceTeamId: partner.id, target: mine.id }]) sc = moveScenario(sc, league.teams, m).scenario;
    const r = simulateTrades({ evaluator, teams: league.teams, baseline: evaluator.evaluate(league.teams), slots: league.rosterSlots, scenario: sc, myTeamId: mine.id, goals: unsetGoals() });
    assert.deepEqual(r.blockers, []);
    for (const [k, id] of [mine.id, partner.id].entries()) {
      const impact = r.impacts.find(i => i.teamId === id), table = result.locator('table').nth(k);
      for (const [i, c] of impact.categories.entries()) {
        const cells = await table.locator('tbody tr').nth(i).locator('td').allInnerTexts();
        assert.deepEqual([cells[0], cells[1], cells[3]], [formatValue(c.category, c.before), formatValue(c.category, c.after), `${c.beforeRank}. → ${c.afterRank}.`]);
      }
    }
    assert.equal(await noHorizontalScroll(p), true);
    if (engine === 'chromium') await capture(p, `trade-${width}`);
    assert.ok(s.requests.every(x => x.method === 'GET'), 'no ESPN trade or roster write');
  });

  test(`${engine}: three-team scenario, waiver move, capacity warning, undo/reset, edits clear the confirmed result`, async t => {
    const raw = realLeagueRaw(), mine = raw.teams[3], a = raw.teams[0], b = raw.teams[1];
    const s = await openSeason(t, engine, 1280, { raw }); await s.enter(base, 'Takas Asistanı');
    const p = s.page; await region(p).locator('.season-trade-team').first().waitFor();
    await region(p).getByLabel('Takas yapılacak takım').selectOption({ label: a.name });
    await region(p).getByRole('button', { name: 'Takım ekle' }).click();
    await region(p).getByLabel('2. takım').selectOption({ label: b.name });
    const x = firstRegular(mine).playerPoolEntry.player, y = firstRegular(a).playerPoolEntry.player, z = firstRegular(b).playerPoolEntry.player;
    await move(p, x.fullName, `→ ${a.name}`); await move(p, y.fullName, `→ ${b.name}`);
    // b now has one extra regular player unless one leaves: capacity is checked before evaluation.
    const over = (raw.teams[1].roster.entries.filter(e => e.lineupSlotId !== 13).length + 1) > Object.entries(raw.settings.rosterSettings.lineupSlotCounts).filter(([k]) => Number(k) <= 12).reduce((n, [, v]) => n + v, 0);
    if (over) { await region(p).getByText('kapasiteyi aşıyor', { exact: false }).first().waitFor(); assert.equal(await region(p).getByRole('button', { name: 'Takasın etkisini gör' }).isDisabled(), true); }
    await move(p, z.fullName, `→ ${mine.name}`);
    await region(p).getByRole('button', { name: 'Takasın etkisini gör' }).click();
    const result = p.getByRole('region', { name: 'Takas sonucu' }); await result.locator('table').nth(2).waitFor();
    assert.equal(await result.locator('table').count(), 3, 'all three involved teams');
    assert.deepEqual(JSON.parse(await p.evaluate(k => sessionStorage.getItem(k), tradeScenarioKey(789, 2027, mine.id))).moves.map(m => m.playerId), [x.id, y.id, z.id]);
    // A new move removes the confirmation; the result is not silently recomputed.
    const w = raw.teams[3].roster.entries.find(e => e.lineupSlotId !== 13 && e.playerId !== x.id).playerPoolEntry.player;
    await move(p, w.fullName, '→ Waiver');
    assert.equal(await p.getByRole('region', { name: 'Takas sonucu' }).count(), 0);
    await region(p).getByRole('button', { name: 'Son hamleyi geri al' }).click();
    assert.equal(await p.getByRole('combobox', { name: `${w.fullName} hedefi` }).inputValue(), String(mine.id));
    await region(p).getByRole('button', { name: 'Senaryoyu sıfırla' }).click();
    assert.equal(await region(p).getByText('Henüz hamle yok', { exact: false }).count(), 1);
    await region(p).getByRole('button', { name: 'Son hamleyi geri al' }).click();
    assert.equal(await region(p).locator('.season-trade-moves li').count(), 3, 'reset is undoable');
    await capture(p, 'trade-three-team');
    assert.ok(s.requests.every(r => r.method === 'GET'));
  });
}
