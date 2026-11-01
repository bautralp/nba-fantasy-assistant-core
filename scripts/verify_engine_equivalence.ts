/** The shared league evaluator must reproduce the frozen 9CAT engine exactly.
 * Loads exact frozen bytes from an explicitly configured private baseline pack and compares
 * complete results on the real ten-team league for many virtual roster sets. */
import { readHistorical, readPrivateData } from '../migration/baseline-store.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScenarioSnapshot } from '../src/projections/scenarioSnapshot.ts';
import { adaptCentralRos, parseAnalysisSchedule } from '../src/seasonAnalysis/centralAdapter.ts';
import { analyzeLeague, createLeagueEvaluator } from '../src/seasonAnalysis/analyzeLeague.ts';
import type { LeagueTeam, PublicLeague } from '../src/features/season/model.ts';

const FROZEN = '5a2e013e3e19567b648f6ac950042402a56f6061';
const root = resolve(import.meta.dirname, '..'), src = (p: string) => pathToFileURL(join(root, 'src', p)).href;
const frozen = readHistorical(FROZEN, 'src/seasonAnalysis/analyzeLeague.ts').toString('utf8')
  .replace("'./model.ts'", `'${src('seasonAnalysis/model.ts')}'`).replace("'./lineup.ts'", `'${src('seasonAnalysis/lineup.ts')}'`)
  .replaceAll("'../domain/", `'${src('domain/')}`);
const file = join(mkdtempSync(join(tmpdir(), 'frozen-engine-')), 'analyzeLeague.ts'); writeFileSync(file, frozen);
const old = (await import(pathToFileURL(file).href)).analyzeLeague as typeof analyzeLeague;
const read = (p: string) => JSON.parse(readPrivateData(p).toString('utf8'));
const schedule = parseAnalysisSchedule(read('public/data/analysis-schedule.json')), league = read('tests/fixtures/season-analysis/public-league-normalized.json') as PublicLeague;
const standard = read('public/data/player-projections.json');
let checks = 0;
for (const [name, raw] of [['extended', parseScenarioSnapshot(read('public/data/projection-scenarios.json'), standard).projection], ['standard', standard]] as const) {
  const s = adaptCentralRos(raw, schedule);
  const input = { league, projections: s.projections, schedule, datasetRevision: s.datasetRevision, asOf: s.snapshot.asOf, dataUpdatedAt: s.snapshot.generatedAt, lineupPolicy: 'daily-max-games' as const };
  const evaluator = createLeagueEvaluator(input);
  const variants: (readonly LeagueTeam[] | undefined)[] = [undefined, league.teams];
  // One player removed from each team, a swap between teams 1 and 2, and a duplicated owner.
  for (const t of league.teams) variants.push(league.teams.map(x => x === t ? { ...x, roster: x.roster!.slice(1) } : x));
  const [a, b] = league.teams;
  variants.push(league.teams.map(x => x === a ? { ...x, roster: [...x.roster!.slice(1), b.roster![0]] } : x === b ? { ...x, roster: [...x.roster!.slice(1), a.roster![0]] } : x));
  variants.push(league.teams.map(x => x === b ? { ...x, roster: [...x.roster!, a.roster![0]] } : x));
  for (const teams of variants) {
    const reference = old(teams ? { ...input, teams } : input);
    const full = JSON.stringify(analyzeLeague(teams ? { ...input, teams } : input));
    if (full !== JSON.stringify(reference)) throw new Error(`${name}: analyzeLeague differs from frozen engine`);
    const fast = evaluator.evaluate(teams ?? league.teams);
    if (JSON.stringify({ ...fast, revision: '' }) !== JSON.stringify({ ...reference, revision: '' })) throw new Error(`${name}: evaluator differs from frozen engine`);
    checks += 2;
  }
}
console.log(`Shared engine equals frozen ${FROZEN.slice(0, 7)} engine in ${checks} comparisons.`);
