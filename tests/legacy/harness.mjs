import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

export const root = new URL('../../', import.meta.url);
export const sourceHash = '09207d8c00c80fb9813a29c203e4b6d0e19e428d1e3de8499ba72f0804fabbb3';
export const readJSON = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
export const scenarios = await readJSON('tests/fixtures/scenarios.json');
const players = await readJSON('tests/fixtures/players.json');

export async function start() {
  const html = await readFile(new URL('./v3.3.html', import.meta.url));
  if (createHash('sha256').update(html).digest('hex') !== sourceHash) throw Error('Legacy HTML changed; do not refresh the baseline.');
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  } catch (error) { server.close(); throw error; }
  return {
    version: browser.version(),
    async run(scenario, { inspectReference = false } = {}) {
      const context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
      const page = await context.newPage();
      const errors = [], dialogs = [];
      page.on('pageerror', error => errors.push(error.message));
      let accept = true;
      page.on('dialog', async dialog => {
        dialogs.push({ type: dialog.type(), message: dialog.message(), accepted: accept });
        if (accept) await dialog.accept(); else await dialog.dismiss();
      });
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        // The full, unmodified document has already executed attachEvents() and go().
        const imported = await page.evaluate(({scenario, players}) => {
          const rows = scenario.rows ?? scenario.pool.map(i => ({...players[i], ...(scenario.identical ? Object.fromEntries(Object.entries(players[0]).filter(([k])=>!['PLAYER','RANK','POS'].includes(k))) : {}), ...scenario.overrides?.[i]}));
          state = DEFAULT_STATE();
          state.teams = Array.from({length:10}, (_, i) => `Team ${i}`);
          state.myTeam = scenario.myTeam;
          state.targets = scenario.targets;
          const parsed = rows.length ? fromObjects(rows, scenario.mode, 'fixed-fixture.json') : {records:[],duplicates:0,incomplete:0};
          state.players = parsed.records;
          state.picks = scenario.picks;
          invalidate(); render();
          return parsed;
        }, {scenario, players});
        let referenceIds;
        if (inspectReference) {
          // Observe the local ref array with the debugger; never rewrite/instrument source.
          const cdp = await context.newCDPSession(page);
          await cdp.send('Debugger.enable');
          const lineNumber = html.toString().split('\n').findIndex(line => line.startsWith('const b=baseline(ref);'));
          if (lineNumber < 0) throw Error('Reference observation point missing');
          let observationError;
          cdp.on('Debugger.paused', async ({callFrames}) => {
            try {
              const {result,exceptionDetails} = await cdp.send('Debugger.evaluateOnCallFrame', {
                callFrameId:callFrames[0].callFrameId, expression:'ref.map(o => o.p.id)', returnByValue:true
              });
              if (exceptionDetails) throw Error('Reference observation failed');
              referenceIds = result.value;
            } catch (error) { observationError = error; }
            finally { await cdp.send('Debugger.resume'); }
          });
          await cdp.send('Debugger.setBreakpointByUrl', {lineNumber, url:page.url()});
          await page.evaluate(() => { invalidate(); calculateModel(); });
          await cdp.detach();
          if (observationError) throw observationError;
          if (!referenceIds) throw Error('Reference breakpoint was not reached');
        }
        const checkpoints = [];
        for (const action of scenario.actions ?? []) {
          accept = action.confirm !== false;
          await page.evaluate(({fn,args}) => { globalThis[fn](...args); }, action);
          checkpoints.push(await page.evaluate(() => ({ picks:state.picks, teams:state.teams, myTeam:state.myTeam, next:myNextPick(), turn:onMyTurn(), toast:$('toast').textContent, saved:JSON.parse(localStorage.getItem(KEY)) })));
        }
        const result = await page.evaluate(() => {
          const model = calculateModel(), scores = teamsScores();
          const compactLineup = l => ({...l,assigned:Object.fromEntries(Object.entries(l.assigned).map(([slot,p])=>[slot,p.id]))});
          return {
            totals:state.players.map(p=>({id:p.id,totals:projectTotals(p)})),
            model:{...model,valid:model.valid.map(o=>o.p.id),z:Object.fromEntries(model.z)},
            scores,ranks:rankTeams(scores),balance:balancePlan(),threats:threats(scores),
            suggestions:suggestions().map(r=>({...r,p:r.p.id})),
            lineups:state.teams.map((_,i)=>compactLineup(lineup(i))),
            eligibility:state.players.map(p=>({id:p.id,slots:SLOTS.map(s=>eligible(p,s)),fit:positionFit(state.myTeam,p)})),
            snake:Array.from({length:131},(_,n)=>({n,team:nextTeamIdx(n),round:nextRound(n)})),
            next:myNextPick(),turn:onMyTurn(),picks:state.picks,
            // Probe exact legacy tie boundaries with fixed score inputs, not a replacement ranking algorithm.
            tieRanks:rankTeams([0,5e-11,2e-10].map((v,i)=>({i,score:Object.fromEntries(CATS.map(c=>[c,v]))})))
          };
        });
        if (errors.length) throw Error(errors.join('\n'));
        return { imported, ...result, checkpoints, dialogs, ...(inspectReference ? {referenceIds} : {}) };
      } finally { await context.close(); }
    },
    async close() { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
  };
}
