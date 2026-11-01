/** Read-only production gate. Never generates, replaces or relabels projections. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProjections } from '../src/features/rankings/rosProjection.ts';
import { parseScenarioSnapshot } from '../src/projections/scenarioSnapshot.ts';

export function verifyProjectionPublication(directory: string) {
  const standardBytes = readFileSync(resolve(directory, 'data/player-projections.json'));
  const raw: unknown = JSON.parse(readFileSync(resolve(directory, 'data/projection-scenarios.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !('modelVersion' in raw) || raw.modelVersion !== 'unified-ros/2') {
    throw new Error('Production publication requires unified-ros/2; legacy or missing scenarios cannot be published.');
  }
  // Reuse the application's full schema, exact-ID, date, source and invariance checks.
  const standard = parseProjections(JSON.parse(standardBytes.toString('utf8')));
  const scenario = parseScenarioSnapshot(raw, standard);
  const standardSHA256 = createHash('sha256').update(standardBytes).digest('hex');
  if (scenario.inputRevision.standardSHA256 !== standardSHA256) {
    throw new Error('Projection publication Standard ROS SHA-256 mismatch; the scenario belongs to another source revision.');
  }
  return { modelVersion: scenario.modelVersion, asOf: scenario.asOf, standardGeneratedAt: scenario.standardGeneratedAt, standardSHA256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || process.argv.length !== 3) throw new Error('Usage: verify_projection_publication.ts BUILD_DIRECTORY');
    console.log('Projection publication compatibility verified:', verifyProjectionPublication(process.argv[2]));
  } catch (error) {
    console.error('Production publication blocked:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
