import { mkdir, writeFile } from 'node:fs/promises';
import { start, scenarios, sourceHash, root } from './harness.mjs';

// Creation only: intentionally cannot overwrite an existing oracle directory.
const destination = new URL('tests/fixtures/expected/', root);
await mkdir(destination);
const runner = await start();
try {
  for (const scenario of scenarios) {
    const result = await runner.run(scenario);
    await writeFile(new URL(`${scenario.name}.json`, destination), JSON.stringify(result, null, 2)+'\n', {flag:'wx'});
    console.log(`Captured ${scenario.name}`);
  }
  await writeFile(new URL('provenance.json', destination), JSON.stringify({
    sourceCommit:'0e28afb9d0c2fff0e6fa9e25d90651fab7fa4ed5',
    baseMainCommit:'71b3d84347e08f576dec1e7eada6e32609e0d2cd',
    sourceBlob:'6f774efbb3d932f59baa7cd6d2f7a097a7a6faef',
    sourceSha256:sourceHash, node:process.version, chromium:runner.version,
    command:'CHROMIUM_PATH=/usr/bin/chromium npm run test:capture',
    method:'Unmodified frozen tests/legacy/v3.3.html served over loopback HTTP; real browser globals and DOM; no application functions replaced.'
  },null,2)+'\n', {flag:'wx'});
} finally { await runner.close(); }
