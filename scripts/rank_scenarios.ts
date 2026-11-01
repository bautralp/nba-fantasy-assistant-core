import { readFileSync, writeFileSync } from 'node:fs';
import { rankScenarioSnapshot } from '../src/projections/scenarioSnapshot.ts';
const path = process.argv[2]; if (!path) throw new Error('Scenario path required');
const result = rankScenarioSnapshot(JSON.parse(readFileSync(path,'utf8')));
writeFileSync(path,JSON.stringify(result)+'\n');
