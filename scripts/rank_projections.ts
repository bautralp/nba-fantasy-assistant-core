import { readFileSync, writeFileSync } from 'node:fs';
import { rankProjections, parseProjections } from '../src/features/rankings/rosProjection.ts';
const path = process.argv[2]!;
const candidate: unknown = JSON.parse(readFileSync(path, 'utf8'));
const ranked = rankProjections(parseProjections(candidate, false));
parseProjections(ranked);
writeFileSync(path, JSON.stringify(ranked) + '\n');
