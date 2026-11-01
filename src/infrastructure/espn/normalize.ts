import type { PublicLeague, LeaguePlayer, MatchupSide } from '../../features/season/model.ts';
import { normalizeDisplayPositions } from '../../features/season/positions.ts';
import { slotLabel } from '../../features/season/model.ts';
export class EspnError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'EspnError'; }
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const integer = (v: unknown): number | null => num(v) !== null && Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
function fail(): never { throw new EspnError('validation', 'ESPN lig verisi eksik veya beklenmeyen biçimde.'); }
const labels: Record<number, string> = { 0: 'PTS', 1: 'BLK', 2: 'STL', 3: 'AST', 6: 'REB', 11: 'TO', 13: 'FGM', 14: 'FGA', 15: 'FTM', 16: 'FTA', 17: '3PM', 19: 'FG%', 20: 'FT%', 21: '3P%' };
export function normalizeLeague(raw: unknown, leagueId: number, seasonId: number, fetchedAt = new Date().toISOString()): PublicLeague {
  const r = obj(raw), settings = obj(r.settings), scoring = obj(settings.scoringSettings), roster = obj(settings.rosterSettings), status = obj(r.status);
  if (r.id !== leagueId || r.seasonId !== seasonId) fail();
  if (settings.isPublic === false) throw new EspnError('private', 'Bu lig public değil. Yalnız anonim public ESPN ligleri destekleniyor.');
  if (settings.isPublic !== true || !str(settings.name) || !str(scoring.scoringType) || !Array.isArray(scoring.scoringItems) || !Array.isArray(r.teams) || !r.teams.length || !Object.keys(obj(roster.lineupSlotCounts)).length || (r.status === null || typeof r.status !== 'object' || Array.isArray(r.status))) fail();
  const teamIds = new Set<number>(), playerIds = new Set<number>();
  const teams = r.teams.map(value => {
    const t = obj(value), id = integer(t.id), overall = obj(obj(t.record).overall);
    const name = str(t.name) ?? str([str(t.location), str(t.nickname)].filter(Boolean).join(' '));
    if (id === null || teamIds.has(id) || !name) fail();
    teamIds.add(id);
    const entries = obj(t.roster).entries;
    if (entries !== undefined && !Array.isArray(entries)) fail();
    const players: LeaguePlayer[] | null = !Array.isArray(entries) ? null : entries.map(value => {
      const e = obj(value), p = obj(obj(e.playerPoolEntry).player), pid = integer(p.id), slot = integer(e.lineupSlotId);
      if (pid === null || pid === 0 || playerIds.has(pid) || !str(p.fullName) || e.playerId !== undefined && e.playerId !== pid) fail();
      playerIds.add(pid);
      if (p.eligibleSlots != null && (!Array.isArray(p.eligibleSlots) || p.eligibleSlots.some(v => integer(v) === null))) fail();
      const eligible = Array.isArray(p.eligibleSlots) ? p.eligibleSlots as number[] : null;
      return { ...normalizeDisplayPositions(p.defaultPositionId, eligible), espnPlayerId: pid, name: str(p.fullName)!, proTeamId: integer(p.proTeamId), eligibleSlotIds: Array.isArray(p.eligibleSlots) ? p.eligibleSlots as number[] : null, lineupSlotId: slot,
        placement: slot === 12 ? 'bench' : slot === 13 ? 'ir' : slot !== null && slot >= 0 && slot <= 11 ? 'active' : 'unknown' };
    });
    return { espnTeamId: id, name, rank: integer(t.rankCalculatedFinal) !== null && (t.rankCalculatedFinal as number) > 0 ? t.rankCalculatedFinal as number : null, record: Object.keys(overall).length ? { wins: integer(overall.wins), losses: integer(overall.losses), ties: integer(overall.ties) } : null, gamesBack: num(overall.gamesBack) !== null && (overall.gamesBack as number) >= 0 ? overall.gamesBack as number : null, roster: players };
  });
  function side(value: unknown): MatchupSide | null {
    if (value === undefined || value === null) return null;
    const s = obj(value), id = integer(s.teamId); if (id === null || !teamIds.has(id)) fail();
    const cumulative = obj(s.cumulativeScore), stats = cumulative.scoreByStat;
    const categoryStats: Record<string, number> | null = stats == null ? null : {};
    if (stats != null) {
      if (!Object.keys(obj(stats)).length && (stats === null || typeof stats !== 'object' || Array.isArray(stats))) fail();
      for (const [key, value] of Object.entries(obj(stats))) { const n = num(obj(value).score); if (!/^\d+$/.test(key)) fail(); if (n !== null) categoryStats![key] = n; }
    }
    return { teamId: id, score: num(s.totalPoints), categoryStats,
      categoryRecord: ['wins', 'losses', 'ties'].some(key => num(cumulative[key]) !== null)
        ? { wins: num(cumulative.wins), losses: num(cumulative.losses), ties: num(cumulative.ties) } : null };
  }
  if (r.schedule !== undefined && !Array.isArray(r.schedule)) fail();
  // Draft order is optional league metadata: an incomplete or inconsistent list becomes null, never a guessed order.
  const draft = obj(settings.draftSettings), order = Array.isArray(draft.pickOrder) ? draft.pickOrder.map(integer) : null;
  const pickOrder = order && order.length === teamIds.size && order.every(id => id !== null && teamIds.has(id)) && new Set(order).size === order.length ? order as number[] : null;
  return { schemaVersion: 1, provider: 'ESPN', leagueId, seasonId, name: str(settings.name)!, visibility: 'public', fetchedAt,
    scoring: { type: str(scoring.scoringType)!, analysisSupported: false, categories: scoring.scoringItems.map(value => { const item = obj(value), id = integer(item.statId); if (id === null) fail(); return { statId: id, label: labels[id] ?? `ESPN stat ${id}`, points: num(item.points), isReverse: typeof item.isReverseItem === 'boolean' ? item.isReverseItem : null }; }) },
    lineupRules: { lineupLocktimeType: str(roster.lineupLocktimeType), rosterLocktimeType: str(roster.rosterLocktimeType), hasGameLimits: roster.lineupSlotStatLimits && typeof roster.lineupSlotStatLimits === 'object' && !Array.isArray(roster.lineupSlotStatLimits) ? Object.keys(obj(roster.lineupSlotStatLimits)).length > 0 : null, allowOutOfPositionScoring: typeof scoring.allowOutOfPositionScoring === 'boolean' ? scoring.allowOutOfPositionScoring : null },
    draftSettings: { type: str(draft.type), pickOrder },
    rosterSlots: Object.entries(obj(roster.lineupSlotCounts)).map(([key, value]) => { const id = Number(key), count = integer(value); if (!/^\d+$/.test(key) || count === null) fail(); return { slotId: id, label: slotLabel(id), count }; }),
    scoringPeriodId: integer(r.scoringPeriodId), matchupPeriodId: integer(status.currentMatchupPeriod), teams,
    matchups: Array.isArray(r.schedule) ? r.schedule.map(value => { const m = obj(value), period = integer(m.matchupPeriodId); if (period === null) fail(); return { matchupPeriodId: period, home: side(m.home), away: side(m.away) }; }) : null };
}
