/** Version 1 read contract. Null always means unavailable, never an inferred zero. */
export type BasketballPosition = 'PG' | 'SG' | 'SF' | 'PF' | 'C';
export interface LeaguePlayer {
  espnPlayerId: number; name: string; proTeamId: number | null;
  eligibleSlotIds: number[] | null; lineupSlotId: number | null;
  primaryPosition: BasketballPosition | null; displayPositions: BasketballPosition[];
  placement: 'active' | 'bench' | 'ir' | 'unknown';
}
export interface LeagueTeam {
  /** Legacy final rank only, never a current standings position. */
  espnTeamId: number; name: string; rank: number | null;
  record: { wins: number | null; losses: number | null; ties: number | null } | null;
  gamesBack: number | null;
  roster: LeaguePlayer[] | null;
}
export interface MatchupSide {
  teamId: number; score: number | null;
  /** Provider category W/L/T, distinct from raw per-category statistics. */
  categoryRecord: { wins: number | null; losses: number | null; ties: number | null } | null;
  /** ESPN cumulativeScore.scoreByStat stat IDs; no locally calculated category wins. */
  categoryStats: Record<string, number> | null;
}
export interface PublicLeague {
  schemaVersion: 1; provider: 'ESPN'; leagueId: number; seasonId: number; name: string;
  visibility: 'public'; fetchedAt: string;
  scoring: { type: string; analysisSupported: false; categories: { statId: number; label: string; points: number | null; isReverse: boolean | null }[] };
  lineupRules?: { lineupLocktimeType: string | null; rosterLocktimeType: string | null; hasGameLimits: boolean | null; allowOutOfPositionScoring: boolean | null };
  /** First-round ESPN team IDs from settings.draftSettings.pickOrder; null when ESPN has not set a complete order. */
  draftSettings?: { type: string | null; pickOrder: number[] | null };
  rosterSlots: { slotId: number; label: string; count: number }[];
  scoringPeriodId: number | null; matchupPeriodId: number | null;
  teams: LeagueTeam[];
  matchups: { matchupPeriodId: number; home: MatchupSide | null; away: MatchupSide | null }[] | null;
}
/** FBA slots follow scripts/fba-slot-mapping-2027.json reviewed evidence; unknown IDs stay unknown. */
export const slotLabel = (id: number) => ({ 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL', 12: 'Bench', 13: 'IR', 15: 'Rookie' } as Record<number, string>)[id] ?? `ESPN slot ${id}`;
