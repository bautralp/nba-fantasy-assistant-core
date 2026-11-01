import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnsetTargets, NINE_CATEGORIES } from '../../src/domain/models/categories.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';
import { initialDialogTargets } from '../../src/features/draft/strategyDefaults.ts';
import { recommendations, calculateModel, teamScores } from '../../src/engine/index.ts';
import { deriveDraftRoster } from '../../src/domain/rules/draftRules.ts';
import { fresh } from '../helpers/draftFixture.ts';

test('the dialog suggests İlk 5 only when no target exists and never mutates the input', () => {
  const unset = createUnsetTargets();
  const result = initialDialogTargets(unset);
  assert.equal(result.suggested, true);
  for (const c of NINE_CATEGORIES) assert.equal(result.values[c], 'top5');
  assert.deepEqual(unset, createUnsetTargets());
  const chosen = { ...unset, PTS: 'top3' as const, TO: 'punt' as const };
  assert.deepEqual(initialDialogTargets(chosen), { values: chosen, suggested: false });
  assert.equal(initialDialogTargets({ ...unset, 'FT%': 'punt' }).suggested, false, 'an explicit punt is a real choice');
});

test('stored and engine defaults stay unset: new workspaces and recommendations are unchanged', () => {
  const w = createInitialWorkspace({ leagueId: 'l', season: '2026-27', teamIds: Array.from({ length: 10 }, (_, i) => `t${i}`), draftSessionId: 'd' });
  for (const s of w.strategies) assert.deepEqual(s.targets, createUnsetTargets());
  const f = fresh(30), model = calculateModel(f.players, f.projections, f.datasets[0]);
  const roster = deriveDraftRoster(f.draftSession!);
  assert.deepEqual(recommendations({ players: f.players, projections: f.projections, teams: f.teams, roster, model, teamId: 't0', targets: createUnsetTargets(), eligibility: f.eligibility }), [],
    'no active targets still means no recommendations in the engine');
  assert.ok(teamScores(f.teams, roster, model));
});
