import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSnapshot, periods } from '../../src/features/rankings/centralStats.ts';
const original = () => JSON.parse(readFileSync(new URL('../../public/data/player-stats.json', import.meta.url), 'utf8'));
test('published provider snapshot has five periods, real identities and actual statistics', () => {
  const snapshot = parseSnapshot(original());
  assert.deepEqual(Object.keys(snapshot.periods), Object.keys(periods));
  assert.ok(snapshot.periods.season.players.length > 0);
  assert.ok(snapshot.periods.lastSeason.players.length > 0);
  for (const period of Object.values(snapshot.periods)) for (const p of period.players) {
    assert.ok(p.gp > 0);
    for (const [key, total] of Object.entries(p.totals)) assert.equal(p.stats[key as keyof typeof p.stats], total / p.gp);
    assert.equal(p.stats['FG%'], p.totals.FGA ? p.totals.FGM / p.totals.FGA * 100 : null);
    assert.equal(p.stats['FT%'], p.totals.FTA ? p.totals.FTM / p.totals.FTA * 100 : null);
  }
});
test('network schema rejects malformed metadata, missing periods, rows and numeric values', () => {
  const changes = [
    (v: any) => { v.schemaVersion = 2; },
    (v: any) => { v.unit = 'totals'; },
    (v: any) => { v.seasonType = 'postseason'; },
    (v: any) => { v.asOf = '2026-02-30'; },
    (v: any) => { v.refreshedAt = 'bad date'; },
    (v: any) => { delete v.periods.last14; },
    (v: any) => { v.periods.season.season = '2025-26'; },
    (v: any) => { v.periods.season.players[0].gp = 0; },
    (v: any) => { v.periods.season.players[0].stats.PTS = null; },
    (v: any) => { v.periods.season.players[0].stats.PTS = Infinity; },
    (v: any) => { v.periods.season.players[0].stats['FG%'] = 101; },
    (v: any) => { v.periods.season.players.push(v.periods.season.players[0]); },
    (v: any) => { v.periods.season.dataThrough = null; },
    (v: any) => { v.periods.season.from = '2099-01-01'; },
  ];
  for (const change of changes) { const v = original(); change(v); assert.throws(() => parseSnapshot(v), /doğrulanamadı/); }
  for (const v of [null, [], {}, 'invalid']) assert.throws(() => parseSnapshot(v));
});
