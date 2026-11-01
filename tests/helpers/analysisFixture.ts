import { readFileSync } from 'node:fs';
import { fresh } from './draftFixture.ts';
import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import type { ProjectionStats } from '../../src/domain/models/projection.ts';
import type { CategoryTargets } from '../../src/domain/models/categories.ts';
import type { Position } from '../../src/domain/models/roster.ts';

/** Boundary adapter for frozen legacy inputs; no calculation and no oracle generation. */
export function analysisFixture(name: string) {
  const read = (file: string) => JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8'));
  const scenario = read('scenarios.json').find((s: { name: string }) => s.name === name);
  const expected = read(`expected/${name}.json`);
  const base = fresh(0);
  const statMap = { FGM: 'fgm', FGA: 'fga', FTM: 'ftm', FTA: 'fta', '3PM': 'three', PTS: 'pts', REB: 'reb', AST: 'ast', STL: 'stl', BLK: 'blk', TO: 'to' };
  type RecordInput = { id: string; name: string; rank: number | null; valid: boolean; pos: string; values: Record<string, number> };
  const records: RecordInput[] = expected.imported.records;
  const workspace: WorkspaceSnapshot = { ...base,
    league: { ...base.league, userTeamId: `t${scenario.myTeam}` },
    teams: base.teams.map((t, i) => ({ ...t, name: `Team ${i}` })),
    datasets: [{ ...base.datasets[0], unit: scenario.mode }],
    players: records.map(p => ({ id: p.id, name: p.name })),
    projections: records.map(p => ({ playerId: p.id, datasetId: 'data', ...(p.rank == null ? {} : { rank: p.rank }),
      ...(p.valid ? { status: 'valid' as const, gamesPlayed: p.values.gp, stats: Object.fromEntries(Object.entries(statMap).map(([key, value]) => [key, p.values[value]])) as ProjectionStats }
        : { status: 'excluded' as const, reasons: ['fixed invalid'] }) })),
    eligibility: records.map(p => ({ playerId: p.id, season: 'fixture', scope: { kind: 'dataset', datasetId: 'data' }, positions: p.pos.toUpperCase().split(/[^A-Z]+/).filter(Boolean) as Position[] })),
    strategies: base.strategies.map(s => s.teamId === `t${scenario.myTeam}` ? { ...s, targets: scenario.targets as CategoryTargets } : s),
    draftSession: { ...base.draftSession!, picks: expected.picks.map((p: { id: string; team: number }, selectionIndex: number) => ({ playerId: p.id, teamId: `t${p.team}`, selectionIndex, outOfTurnConfirmed: true })), status: expected.picks.length === 130 ? 'completed' : expected.picks.length ? 'inProgress' : 'setup' },
  };
  return { workspace, expected };
}
