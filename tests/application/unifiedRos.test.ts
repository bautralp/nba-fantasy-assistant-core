import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedScenario as source, unifiedStandard, legacyScenario } from '../helpers/unifiedScenario.ts';
import { parseScenarioSnapshot } from '../../src/projections/scenarioSnapshot.ts';
import { rankProjections } from '../../src/features/rankings/rosProjection.ts';
const standard = unifiedStandard;
const rows = new Map(source.projection.players.map(p => [p.id, p]));
test('all 513 standard performances survive, including Jokic, Kawhi and LeBron; 65 missing performances completed', () => {
  let preserved = 0, completed = 0;
  for (const b of standard.players) {
    const p = rows.get(b.id)!;
    if (b.status === 'available') {
      assert.deepEqual(p.stats, b.stats, b.name); assert.deepEqual(p.shooting, b.shooting, b.name); assert.equal(p.minutes, b.minutes, b.name); preserved++;
      if (source.players[b.id]!.tier === 'standard' && b.rosGP !== null) {
        const withoutRank = (r: object) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'rank' && k !== 'totalZ'));
        assert.deepEqual(withoutRank(p), withoutRank(b), b.name);
        assert.deepEqual(source.players[b.id]!.roleUse.used, []);
      }
    } else if (p.status === 'available') completed++;
    if (b.rosGP === 0) assert.equal(p.rosGP, 0, b.name);
  }
  assert.equal(preserved, 513); assert.equal(completed, 65);
  for (const name of ['Nikola Jokic', 'Kawhi Leonard', 'LeBron James']) assert.equal(source.players[standard.players.find((p: any) => p.name === name).id]!.tier, 'standard');
  assert.deepEqual(rankProjections(source.projection), source.projection);
});
test('v2 boundary rejects relabelled legacy scenario, standard performance mutation, GP mutation and false scientific acceptance', () => {
  const legacy = structuredClone(legacyScenario);
  legacy.modelVersion = 'unified-ros/2'; assert.throws(() => parseScenarioSnapshot(legacy, standard));
  for (const edit of [(r: any) => r.rosGP--, (r: any) => r.minutes--, (r: any) => r.confidence = 'high']) {
    const s = structuredClone(source), p = s.projection.players.find(p => p.name === 'Nikola Jokic')!;
    edit(p); assert.throws(() => parseScenarioSnapshot(s, standard));
  }
  const s = structuredClone(source); s.scientificGatesEnabled = true as false;
  assert.throws(() => parseScenarioSnapshot(s, standard));
});
