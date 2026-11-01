import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fresh } from '../helpers/draftFixture.ts';
import { applyDraftCommand } from '../../src/application/draftCommands.ts';
import { selectDraftWorkspace } from '../../src/application/draftSelectors.ts';
import { selectDraftAnalysis } from '../../src/application/analysisSelectors.ts';
import { exportWorkspaceJson, restoreWorkspaceJson } from '../../src/infrastructure/persistence/workspaceJson.ts';
import { createWorkbook, readWorkbook } from '../../src/infrastructure/projections/workbook.ts';
import { prepareManualImport } from '../../src/application/manualImport.ts';
import { inspectImport } from '../../src/application/importPlayers.ts';
const results = [];
const measure = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
for (const size of [150, 300, 600]) {
  const runs = [];
  for (let run = 0; run < 4; run++) {
    let w = fresh(size);
    const bytes = createWorkbook('fixture', 'perGame', w.projections.map((p, i) => [w.players[i].name, 'C', i + 1, p.gamesPlayed, ...['FGM','FGA','FTM','FTA','3PM','PTS','REB','AST','STL','BLK','TO'].map(k => p.stats[k])]));
    const read = measure(() => readWorkbook(bytes, 'synthetic.xlsx'));
    const preview = measure(() => { const p = prepareManualImport(read.value, {}, w, 0, () => crypto.randomUUID(), '2026-10-20T00:00:00Z'); return inspectImport(p, {}); });
    assert.equal(preview.value.valid, size); assert.deepEqual(preview.value.errors, []);
    const initial = measure(() => selectDraftWorkspace(w));
    const picks = [], selectors = [], analyses = [];
    for (let i = 0; i < 130; i++) {
      const teamId = w.draftSession.draftOrder[Math.floor(i / 10) % 2 ? 9 - i % 10 : i % 10];
      const command = measure(() => applyDraftCommand(w, { kind: 'assign', playerId: `p${i}`, teamId })); w = command.value; picks.push(command.ms);
      const view = measure(() => selectDraftWorkspace(w)); selectors.push(view.ms);
      analyses.push(measure(() => selectDraftAnalysis(w, view.value)).ms);
    }
    const backup = measure(() => exportWorkspaceJson(w));
    const restore = measure(() => restoreWorkspaceJson(backup.value.value));
    assert.ok(restore.value.ok); assert.deepEqual(restore.value.value, w);
    const percentile = (a, p) => [...a].sort((a,b) => a-b)[Math.floor((a.length-1)*p)];
    if (run) runs.push({ xlsxRead: read.ms, preview: preview.ms, initialSelector: initial.ms, pickP95: percentile(picks,.95), recommendationsP95: percentile(selectors,.95), analysisP95: percentile(analyses,.95), backup: backup.ms, restore: restore.ms });
  }
  for (const r of runs) {
    for (const [operation, limit] of Object.entries({ xlsxRead: 1500, preview: 500, initialSelector: 100, pickP95: 50, recommendationsP95: 100, analysisP95: 50, backup: 250, restore: 250 })) assert.ok(r[operation] < limit, `${size} ${operation}: ${r[operation]}ms exceeds ${limit}ms`);
  }
  results.push({ size, medianMs: Object.fromEntries(Object.keys(runs[0]).map(key => [key, +runs.map(r => r[key]).sort((a,b)=>a-b)[1].toFixed(3)])) });
}
mkdirSync('artifacts/performance', { recursive: true });
writeFileSync(process.argv[2] || 'artifacts/performance/current.json', JSON.stringify({ node: process.version, methodology: '1 warmup + 3 measured runs; median; 130 snake picks, real selectors, synthetic data; selector includes recommendations', results }, null, 2));
console.log(JSON.stringify(results));
