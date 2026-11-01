import { statKeys, type StatsPlayer } from './centralStats.ts';
export interface RosterPlayer { id: string; name: string; team: string; teamId: number; source: string }
export interface CurrentRosters { schemaVersion: 1; season: '2026-27'; provider: 'ESPN NBA rosters'; retrievedAt: string; sources: { url: string; sha256: string }[]; players: RosterPlayer[] }
export function parseRosters(raw: unknown): CurrentRosters {
  const v = raw as CurrentRosters;
  if (!v || v.schemaVersion !== 1 || v.season !== '2026-27' || v.provider !== 'ESPN NBA rosters' || typeof v.retrievedAt !== 'string' || !/T.*(Z|\+00:00)$/.test(v.retrievedAt) || !Number.isFinite(Date.parse(v.retrievedAt)) || !Array.isArray(v.players)) throw new Error('Roster doğrulanamadı.');
  if (!Array.isArray(v.sources) || v.sources.length !== 30 || new Set(v.sources.map(s => s.url)).size !== 30 || v.sources.some(s => !s || !/^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/basketball\/nba\/teams\/(?:[1-9]|[12][0-9]|30)\/roster\?season=2027$/.test(s.url) || !/^[a-f0-9]{64}$/.test(s.sha256))) throw new Error('Roster kaynakları doğrulanamadı.');
  const ids = new Set<string>();
  for (const p of v.players) {
    if (!p || typeof p.id !== 'string' || !/^[1-9]\d*$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.team !== 'string' || !/^[A-Z]{2,4}$/.test(p.team) || !Number.isInteger(p.teamId) || p.teamId < 1 || p.teamId > 30 || p.source !== `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${p.teamId}/roster?season=2027`) throw new Error('Roster kimliği doğrulanamadı.');
    ids.add(p.id);
  }
  return v;
}
/** Only exact ESPN IDs; display rows never enter playerZScores or the draft engine. */
export function zeroGamePlayers(played: readonly StatsPlayer[], roster: CurrentRosters | null, now = Date.now()): StatsPlayer[] {
  if (!roster || now - Date.parse(roster.retrievedAt) > 36 * 3600000 || Date.parse(roster.retrievedAt) > now + 300000) return [];
  const ids = new Set(played.map(p => p.id));
  return roster.players.filter(p => !ids.has(p.id)).map(p => ({
    id: p.id, name: p.name, team: p.team, position: '', gp: 0, mpg: 0,
    totals: Object.fromEntries(statKeys.filter(k => !k.endsWith('%')).map(k => [k, 0])) as StatsPlayer['totals'],
    stats: Object.fromEntries(statKeys.map(k => [k, k.endsWith('%') ? null : 0])) as StatsPlayer['stats'],
  }));
}
