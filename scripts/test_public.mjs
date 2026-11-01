import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const scope=JSON.parse(readFileSync(new URL('../migration/validation-scopes.json',import.meta.url)));
console.log('PUBLIC CORE ONLY: full historical/production validation remains BLOCKED.');
const files=[...scope.javascript,...readdirSync('tests/public').filter(x=>x.endsWith('.test.ts')).map(x=>'tests/public/'+x)];
const reporters=process.env.PUBLIC_TEST_EVENTS?['--test-reporter=tap','--test-reporter-destination=stdout','--test-reporter='+new URL('./public_test_reporter.mjs',import.meta.url).href,'--test-reporter-destination='+process.env.PUBLIC_TEST_EVENTS]:['--test-reporter=tap'];
const r=spawnSync(process.execPath,['--experimental-strip-types','--test',...reporters,'--test-concurrency=1',...files],{stdio:'inherit'});
process.exit(r.status??1);
