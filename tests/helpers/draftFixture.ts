import type { WorkspaceSnapshot } from '../../src/domain/models/workspace.ts';
import { createInitialWorkspace } from '../../src/domain/rules/createWorkspace.ts';
export const fresh = (n = 140): WorkspaceSnapshot => {
  const w = createInitialWorkspace({ leagueId: 'league', season: 'fixture', teamIds: Array.from({ length: 10 }, (_, i) => `t${i}`), draftSessionId: 'draft' });
  return { ...w, league: { ...w.league, name: 'Fixture League', userTeamId: 't0', activeDatasetId: 'data' }, teams: w.teams.map((t, i) => ({ ...t, name: `Fixture Team ${i}` })),
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Fixture Player ${String(i).padStart(3, '0')}` })),
    datasets: [{ id: 'data', schemaVersion: 1, season: 'fixture', unit: 'perGame', source: { name: 'Fixture', kind: 'json' }, importedAt: '2026-10-20T00:00:00Z' }],
    projections: Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, datasetId: 'data', rank: i + 1, status: 'valid' as const, gamesPlayed: 60, stats: { FGM: 5, FGA: 10, FTM: 3, FTA: 4, '3PM': i % 5, PTS: i + 10, REB: 5, AST: 3, STL: 1, BLK: 1, TO: 2 } })),
    eligibility: Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, season: 'fixture', scope: { kind: 'dataset' as const, datasetId: 'data' }, positions: [i % 2 ? 'G' as const : 'C' as const] })) };
};
