/**
 * Hand-authored synthetic ESPN-shaped league. No real league or fixture is read.
 * Defaults match the supported Draft type: 10 teams, 13 non-IR slots, standard 9CAT.
 */
export const NINE_STAT_IDS: number[] = [19, 20, 17, 0, 6, 3, 2, 1, 11];
export const STANDARD_SLOTS: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 11: 3, 12: 3, 13: 1 };
/** First-round order used by default: ESPN team 7 picks first, then 3, 10, 1, 5, 8, 2, 9, 4, 6. */
export const DEFAULT_PICK_ORDER = [7, 3, 10, 1, 5, 8, 2, 9, 4, 6];
export interface LeagueOptions { id?: number; seasonId?: number; teams?: number; slots?: Record<number, number>; statIds?: number[]; scoringType?: string; name?: string; isPublic?: boolean; draft?: { type?: string; pickOrder?: unknown } | null }
export function espnLeague({ id = 123, seasonId = 2027, teams = 10, slots = STANDARD_SLOTS, statIds = NINE_STAT_IDS, scoringType = 'H2H_MOST_CATEGORIES', name = 'Fixture ESPN League', isPublic = true, draft = { type: 'SNAKE', pickOrder: DEFAULT_PICK_ORDER } }: LeagueOptions = {}): any {
  const raw: any = { id, seasonId, scoringPeriodId: 1, status: { currentMatchupPeriod: 1 }, settings: { scoringSettings: { allowOutOfPositionScoring: false }, rosterSettings: { lineupLocktimeType: 'INDIVIDUAL_GAME', rosterLocktimeType: 'FIRSTGAME_SCORINGPERIOD' } }, teams: [] };
  raw.id = id; raw.seasonId = seasonId;
  raw.settings.name = name; raw.settings.isPublic = isPublic;
  raw.settings.scoringSettings.scoringType = scoringType;
  raw.settings.scoringSettings.scoringItems = statIds.map(statId => ({ statId, isReverseItem: statId === 11, points: 0 }));
  raw.settings.rosterSettings.lineupSlotCounts = Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v]));
  // Team IDs are deliberately out of order; the form lists them by ESPN team ID.
  raw.teams = Array.from({ length: teams }, (_, i) => ({ id: teams - i, name: `ESPN Takım ${teams - i}`, record: { overall: { wins: 0, losses: 0, ties: 0 } } }));
  if (draft) raw.settings.draftSettings = draft;
  delete raw.schedule;
  return raw;
}
