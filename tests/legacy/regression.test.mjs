import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { start, scenarios, readJSON } from './harness.mjs';

// Exact structural/order checks, floating-point absolute/relative tolerance only.
function compare(actual, expected, path='$') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path);
    if (/\.(ranks|tieRanks|snake)\.|\.(br|ar|rank|team|teamIndex|count|rated|referenceCount|next|selected|remaining|filled|unknown|total)$/.test(path)) {
      assert.equal(actual, expected, path);
      return;
    }
    assert.ok(Number.isFinite(actual), path);
    assert.ok(Math.abs(actual-expected) <= 1e-9 * Math.max(1,Math.abs(expected)), `${path}: ${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.equal(Array.isArray(actual),Array.isArray(expected),path);
    assert.deepEqual(Object.keys(actual),Object.keys(expected),`${path} keys/order`);
    for (const key of Object.keys(expected)) compare(actual[key],expected[key],`${path}.${key}`);
  } else assert.equal(actual,expected,path);
}
let runner;
const results = new Map();
before(async()=>{runner=await start();});
after(async()=>{await runner?.close();});
for (const scenario of scenarios) test(scenario.name,async()=>{
  const actual=await runner.run(scenario);
  compare(actual,await readJSON(`tests/fixtures/expected/${scenario.name}.json`));
  results.set(scenario.name,actual);
});
test('per-game and equivalent season totals produce identical analysis',()=>{
  const a=results.get('early'), b=results.get('equivalent-totals');
  for(const key of ['totals','model','scores','ranks','balance','suggestions','threats','lineups']) compare(a[key],b[key],key);
});
test('fresh browser context repeats the same output',async()=>{
  compare(await runner.run(scenarios.find(s=>s.name==='middle')),results.get('middle'));
});
test('coverage guards',()=>{
  assert.equal(results.get('reference-over-130').model.referenceCount,130);
  assert.equal(results.get('empty-rosters').suggestions.length,5);
  assert.equal(results.get('completed').suggestions.length,0);
  assert.equal(results.get('completed').next,null);
  assert.equal(results.get('all-invalid').model.usable,false);
  assert.equal(results.get('invalid-projections').imported.incomplete,6);
  assert.ok(results.get('early').threats.some(t=>t.confidence==='Düşük'));
  assert.ok(results.get('middle').threats.some(t=>t.confidence==='Orta'));
  assert.equal(results.get('middle').balance.stage,'Orta turlar');
  assert.equal(results.get('late').balance.stage,'Son turlar');
});
test('actual local reference IDs and debugger observation preserve all outputs',async()=>{
  const references = await readJSON('tests/fixtures/reference-ids.json');
  for (const [name, expectedIds] of Object.entries(references)) {
    const {referenceIds,...observed} = await runner.run(scenarios.find(s=>s.name===name),{inspectReference:true});
    assert.deepEqual(referenceIds,expectedIds);
    compare(observed,results.get(name));
  }
});
