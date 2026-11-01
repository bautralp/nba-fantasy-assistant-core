export const periods = {
  season: 'Season (2026-27)', last7: 'Last 7 Days', last14: 'Last 14 Days',
  last30: 'Last 30 Days', lastSeason: 'Last Season (2025-26)',
} as const;
export type Period = keyof typeof periods;
export const statKeys = ['FGM', 'FGA', 'FTM', 'FTA', 'FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO'] as const;
export type StatKey = typeof statKeys[number];
export interface StatsPlayer {
  id: string; name: string; team: string; position: string; gp: number; mpg?: number;
  totals: Record<Exclude<StatKey, 'FG%' | 'FT%'>, number>;
  stats: Record<StatKey, number | null>;
}
export interface StatsPeriod {
  season: string; from: string; to: string; dataThrough: string | null; players: StatsPlayer[];
}
export interface StatsSnapshot {
  schemaVersion: 1; provider: 'SportsDataverse'; refreshedAt: string; asOf: string;
  unit: 'perGame'; seasonType: 'regular'; periods: Record<Period, StatsPeriod>;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Validate at the network boundary before replacing the displayed snapshot. */
export function parseSnapshot(v: unknown): StatsSnapshot {
  const invalid = () => { throw new Error('İstatistik dosyası doğrulanamadı.'); };
  if (!record(v) || v.schemaVersion !== 1 || v.provider !== 'SportsDataverse' || v.unit !== 'perGame' || v.seasonType !== 'regular' || !day(v.asOf) || typeof v.refreshedAt !== 'string' || !Number.isFinite(Date.parse(v.refreshedAt)) || !record(v.periods)) return invalid();
  for (const key of Object.keys(periods) as Period[]) {
    const p = v.periods[key];
    if (!record(p) || p.season !== (key === 'lastSeason' ? '2025-26' : '2026-27') || !day(p.from) || !day(p.to) || p.from > p.to || p.to > v.asOf || !(p.dataThrough === null || day(p.dataThrough) && p.dataThrough >= p.from && p.dataThrough <= p.to) || !Array.isArray(p.players)) return invalid();
    if ((p.players.length === 0) !== (p.dataThrough === null)) return invalid();
    const ids = new Set<string>();
    for (const row of p.players) {
      if (!record(row) || !['id', 'name', 'team', 'position'].every(k => typeof row[k] === 'string') || !row.id || !row.name || ids.has(row.id as string) || !Number.isInteger(row.gp) || (row.gp as number) < 1 || !record(row.stats) || !record(row.totals)) return invalid();
      if (row.mpg !== undefined && !nonnegative(row.mpg)) return invalid();
      ids.add(row.id as string);
      for (const stat of statKeys) {
        const value = row.stats[stat];
        if (stat === 'FG%' || stat === 'FT%') {
          if (!(value === null || nonnegative(value) && value <= 100)) return invalid();
        } else if (!nonnegative(value) || !nonnegative(row.totals[stat]) || !Number.isInteger(row.totals[stat])) return invalid();
      }
    }
  }
  return v as unknown as StatsSnapshot;
}
