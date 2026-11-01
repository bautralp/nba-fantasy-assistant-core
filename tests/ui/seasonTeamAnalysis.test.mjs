import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { openSeason, expectedEvaluator, capture, noHorizontalScroll } from '../helpers/seasonAnalysisUi.mjs';
import { rosterContributions, categoryStandings } from '../../src/seasonAnalysis/teamInsights.ts';
import { unsetGoals, seasonStrategyKey } from '../../src/seasonAnalysis/strategy.ts';
import { standingText, formatValue } from '../../src/features/season/strategyPresentation.ts';

let server, base;
before(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; });
after(async () => { await server?.close(); });
const region = p => p.getByRole('region', { name: 'Takım Analizi' });
const rows = p => region(p).locator('.season-standing');

for (const engine of (process.env.BROWSER_ENGINES || 'chromium').split(',')) {
  for (const width of [375, 1280]) test(`${engine}: Team Analysis ${width}px shows nine real category standings and roster contributions`, async t => {
    const s = await openSeason(t, engine, width); await s.enter(base, 'Takım Analizi');
    const p = s.page; await rows(p).nth(8).waitFor();
    const { league, evaluator, projections } = expectedEvaluator(s.raw), teamId = s.raw.teams[3].id;
    const expected = rosterContributions(evaluator, league.teams, teamId, unsetGoals(), projections);
    assert.equal(expected.baseline.status, 'ready');
    assert.equal(await rows(p).count(), 9);
    for (const [i, st] of expected.standings.entries()) {
      const row = rows(p).nth(i);
      assert.equal(await row.locator('.season-standing-rank').innerText(), `${st.rank}/10`);
      assert.equal(await row.locator('.season-standing-value').innerText(), formatValue(st.category, st.value));
      if (standingText(st)) assert.equal(await row.locator('.season-standing-text').innerText(), standingText(st)); else assert.equal(await row.locator('.season-standing-text').count(), 0);
      assert.equal(await row.getByRole('combobox').inputValue(), 'unset');
    }
    const nonIr = league.teams.find(x => x.espnTeamId === teamId).roster.filter(x => x.placement !== 'ir');
    assert.equal(await region(p).locator('.season-contribution').count(), nonIr.length);
    // Contributions are ordered by the computed strategy score.
    assert.deepEqual(await region(p).locator('.season-contribution-head strong').allInnerTexts(), expected.players.filter(x => x.impact).map(x => x.name));
    assert.equal(await noHorizontalScroll(p), true);
    assert.doesNotMatch(await region(p).innerText(), /Standart|Genişletilmiş|SHA|revizyon|z-score|model/i);
    if (engine === 'chromium') await capture(p, `team-analysis-${width}`);
  });

  test(`${engine}: goals change advice and weights but never projected values; shared session scope, Draft untouched`, async t => {
    const s = await openSeason(t, engine, 1280); await s.enter(base, 'Takım Analizi');
    const p = s.page; await rows(p).nth(8).waitFor();
    const { league, evaluator, projections } = expectedEvaluator(s.raw), teamId = s.raw.teams[3].id;
    const before = await rows(p).locator('.season-standing-value').allInnerTexts();
    const goals = { ...unsetGoals(), AST: 'top3', '3PM': 'top1', BLK: 'punt', REB: 'punt', 'FT%': 'top3' };
    for (const [c, g] of Object.entries(goals)) if (g !== 'unset') await p.getByRole('combobox', { name: `${c} hedefi` }).selectOption(g);
    const expected = rosterContributions(evaluator, league.teams, teamId, goals, projections);
    const ast = expected.standings.find(x => x.category === 'AST');
    assert.equal(ast.status, 'missed');
    assert.match(standingText(ast), /İlk 3 hedefin için yaklaşık [\d.]+ asist daha gerekiyor\./);
    for (const [i, st] of expected.standings.entries()) if (standingText(st)) assert.equal(await rows(p).nth(i).locator('.season-standing-text').innerText(), standingText(st));
    assert.deepEqual(await rows(p).locator('.season-standing-value').allInnerTexts(), before, 'goals never alter projected values');
    assert.deepEqual(await region(p).locator('.season-contribution-head strong').allInnerTexts(), expected.players.filter(x => x.impact).map(x => x.name));
    const met = expected.standings.filter(x => x.targetRank !== null && x.status === 'met').length;
    await region(p).getByText(`Hedefler: ${met}/3 sağlanıyor`).waitFor();
    if (engine === 'chromium') await capture(p, 'team-analysis-goals');
    const key = seasonStrategyKey(789, 2027, teamId);
    assert.deepEqual(JSON.parse(await p.evaluate(k => sessionStorage.getItem(k), key)), { schemaVersion: 1, goals });
    assert.equal(await p.evaluate(() => sessionStorage.getItem('nba-fantasy-assistant.session.v1')), null, 'Draft workspace is not created or modified');
    await p.getByRole('button', { name: '← Sezon içi ana menü' }).click();
    await p.getByRole('button', { name: 'Takım Analizi', exact: true }).click(); await rows(p).nth(8).waitFor();
    assert.equal(await p.getByRole('combobox', { name: 'AST hedefi' }).inputValue(), 'top3');
    // Another team in the same league has its own independent strategy.
    await p.getByRole('button', { name: 'Takım değiştir' }).click();
    await p.getByRole('button', { name: s.raw.teams[0].name, exact: true }).click();
    await p.getByRole('button', { name: 'Takım Analizi', exact: true }).click(); await rows(p).nth(8).waitFor();
    assert.equal(await p.getByRole('combobox', { name: 'AST hedefi' }).inputValue(), 'unset');
    assert.ok(s.requests.every(r => r.method === 'GET'), 'no ESPN write request');
  });

  test(`${engine}: menu enables all season modules; missing data shows no numbers`, async t => {
    const s = await openSeason(t, engine, 375, { routes: { projections: r => r.fulfill({ status: 500, body: 'x' }) } });
    await s.enter(base);
    const p = s.page;
    assert.equal(await p.getByRole('button', { name: /Takım Analizi/ }).isEnabled(), true);
    for (const name of ['Waiver Asistanı', 'Takas Asistanı']) assert.equal(await p.getByRole('button', { name: new RegExp(name) }).isEnabled(), true);
    assert.equal(await p.getByText('Hazırlanıyor').count(), 0);
    await p.getByRole('button', { name: 'Takım Analizi', exact: true }).click();
    await region(p).getByRole('alert').waitFor();
    assert.match(await region(p).getByRole('alert').innerText(), /yüklenemedi/);
    assert.equal(await rows(p).count(), 0);
  });
}

test('standings thresholds agree with engine ranks for every goal in every category (real league, all teams)', () => {
  const { league, evaluator } = expectedEvaluator();
  const analysis = evaluator.evaluate(league.teams);
  for (const team of league.teams) for (const goal of ['top1', 'top3', 'top5', 'top7']) {
    const st = categoryStandings(analysis, team.espnTeamId, Object.fromEntries(Object.keys(unsetGoals()).map(c => [c, goal])));
    for (const x of st) {
      assert.equal(x.status === 'met', x.rank <= x.targetRank, `${team.espnTeamId} ${x.category} ${goal}`);
      if (x.status === 'missed') {
        // Adding exactly the gap reaches (ties) the target rank; slightly less does not.
        const rows = analysis.rankings[x.category].filter(r => r.teamId !== team.espnTeamId).map(r => r.projectedValue);
        const d = x.category === 'TO' ? -1 : 1, reached = x.value + d * x.gap, short = x.value + d * x.gap * 0.999;
        const better = v => rows.filter(o => d * (o - v) > 1e-9 * Math.max(1, Math.abs(v))).length + 1;
        assert.ok(better(reached) <= x.targetRank && better(short) > x.targetRank, `${x.category} gap`);
      }
    }
  }
});
