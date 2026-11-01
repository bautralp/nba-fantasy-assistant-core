import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const scope=JSON.parse(readFileSync('migration/validation-scopes.json','utf8'));
const reporters=process.env.PUBLIC_TEST_EVENTS?['--test-reporter=tap','--test-reporter-destination=stdout','--test-reporter='+new URL('./public_test_reporter.mjs',import.meta.url).href,'--test-reporter-destination='+process.env.PUBLIC_TEST_EVENTS]:['--test-reporter=tap'];
const r=spawnSync(process.execPath,['--experimental-strip-types','--test',...reporters,'--test-concurrency=1',...scope.ui_files],{stdio:'inherit'});
process.exit(r.status??1);
