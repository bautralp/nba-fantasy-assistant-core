import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseScenarioSnapshot } from '../../src/projections/scenarioSnapshot.ts';
const bundle = JSON.parse(gunzipSync(readFileSync(new URL('../../docs/season/unified-ros/replay-inputs.json.gz', import.meta.url))).toString());
if (bundle.sourceCommit !== '0648a691a1c9fa938b5fb29cb479b2d2178cfb1d') throw new Error('Unexpected archived projection input identity');
export function replayInputBytes(name: string): Buffer {
  const bytes = Buffer.from(bundle.files[name]);
  if (createHash('sha256').update(bytes).digest('hex') !== bundle.sha256[name]) throw new Error('Archived projection input SHA mismatch');
  return bytes;
}
export const unifiedStandard = JSON.parse(replayInputBytes('player-projections.json').toString());
export const unifiedSchedule = JSON.parse(replayInputBytes('analysis-schedule.json').toString());
export const legacyScenario = JSON.parse(replayInputBytes('projection-scenarios.json').toString());
export const unifiedScenario = parseScenarioSnapshot(JSON.parse(gunzipSync(readFileSync(new URL('../../docs/season/unified-ros/candidate.json.gz', import.meta.url))).toString()), unifiedStandard);

if (unifiedScenario.inputRevision.standardSHA256 !== bundle.sha256['player-projections.json']) throw new Error('Archived scenario/Standard SHA mismatch');
