import { CATEGORIES, type AnalysisInput, type AnalysisProjection } from '../../src/seasonAnalysis/model.ts';
import type { LeaguePlayer } from '../../src/features/season/model.ts';

/** Small synthetic 9CAT leagues for strategy, add/drop and trade mathematics. */
export type Line = Partial<Record<'FGM' | 'FGA' | 'FTM' | 'FTA' | '3PM' | 'REB' | 'AST' | 'STL' | 'BLK' | 'TO' | 'PTS', number>>;
export const base: Required<Line> = { FGM: 5, FGA: 10, FTM: 4, FTA: 5, '3PM': 2, REB: 5, AST: 5, STL: 1, BLK: 1, TO: 2, PTS: 15 };
export const player = (id: number, placement: LeaguePlayer['placement'] = 'active'): LeaguePlayer => ({ espnPlayerId: id, name: `P${id}`, proTeamId: 1, eligibleSlotIds: [11, 12, 13], lineupSlotId: placement === 'ir' ? 13 : placement === 'bench' ? 12 : 11, placement, primaryPosition: null, displayPositions: [] });
/** Teams of [id, line, placement] players; every player's NBA team plays both days.
 * `pool` adds projections for unrostered (free agent) players. */
export function league(teams: [number, Line, LeaguePlayer['placement']?][][], pool: [number, Line][] = []): AnalysisInput {
  const projections: AnalysisProjection[] = [...teams.flat(), ...pool].map(([id, line]) => ({ espnId: id, nbaTeamId: 1, kind: 'ROS', unit: 'perGame', expectedGames: 2, teamRemaining: 2, warnings: [], stats: { ...base, ...line } }));
  return { league: { schemaVersion: 1, provider: 'ESPN', leagueId: 99, seasonId: 2027, name: 'Strategy fixture', visibility: 'public', fetchedAt: '2026-10-25T10:00:00Z',
    scoring: { type: 'H2H_MOST_CATEGORIES', analysisSupported: false, categories: CATEGORIES.map((label, statId) => ({ label, statId, points: 1, isReverse: label === 'TO' })) },
    lineupRules: { lineupLocktimeType: 'INDIVIDUAL_GAME', rosterLocktimeType: 'FIRSTGAME_SCORINGPERIOD', hasGameLimits: false, allowOutOfPositionScoring: false },
    rosterSlots: [{ slotId: 11, label: 'UTIL', count: 2 }, { slotId: 12, label: 'Bench', count: 2 }, { slotId: 13, label: 'IR', count: 1 }], scoringPeriodId: 1, matchupPeriodId: 1, matchups: null,
    teams: teams.map((roster, i) => ({ espnTeamId: i + 1, name: `T${i + 1}`, rank: null, record: null, gamesBack: null, roster: roster.map(([id, , placement]) => player(id, placement)) })) },
  projections, schedule: { schemaVersion: 1, seasonId: 2027, asOf: '2026-10-25', through: '2026-10-27', retrievedAt: '2026-10-25T10:00:00Z', source: { url: 'test:synthetic', sha256: 'a'.repeat(64) }, scope: 'observed-regular-season', games: [{ id: '1', date: '2026-10-26', teamIds: [1, 2] }, { id: '2', date: '2026-10-27', teamIds: [1, 2] }] },
  asOf: '2026-10-25', dataUpdatedAt: '2026-10-25T10:00:00Z', datasetRevision: 'v1', lineupPolicy: 'daily-max-games' };
}
