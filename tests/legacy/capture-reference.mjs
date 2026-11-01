import { writeFile } from 'node:fs/promises';
import { start, scenarios, root } from './harness.mjs';
const runner = await start();
try {
  const results = {};
  for (const name of ['single-player','early','reference-exactly-130','reference-over-130']) {
    const result = await runner.run(scenarios.find(s=>s.name===name), {inspectReference:true});
    results[name] = result.referenceIds;
  }
  await writeFile(new URL('tests/fixtures/reference-ids.json',root),JSON.stringify(results,null,2)+'\n',{flag:'wx'});
} finally { await runner.close(); }
