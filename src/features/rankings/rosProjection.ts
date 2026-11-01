import { PROJECTION_STATS, type ProjectionStats } from '../../domain/models/projection.ts';
import { playerZScores } from './playerZScores.ts';
import type { StatsPlayer } from './centralStats.ts';
export const fantasyPositions = ['PG', 'SG', 'SF', 'PF', 'C'] as const;
export type FantasyPosition = typeof fantasyPositions[number];
export interface FantasyEligibility {
  playerId: string; name?: string; season: '2026-27'; positions: FantasyPosition[];
  status: 'verified' | 'unresolved'; provider: string; source: string; retrievedAt: string;
}
export const experienceClasses = ['rookie', 'returning-veteran', 'international-newcomer', 'limited-experience', 'veteran', 'unknown'] as const;
export const projectionBases = ['NBA history', 'NCAA-assisted', 'Rookie prior', 'Current NBA sample'] as const;
export interface ROSPlayer {
  experience?: typeof experienceClasses[number];
  projectionBasis?: typeof projectionBases[number] | null;
  verifiedSourceDate?: string | null; experienceReason?: string | null;
  draftIdentityVerified?: boolean; nbaEntryVerified?: boolean;
  id: string; name: string; team: string; positions: FantasyPosition[]; eligibility: FantasyEligibility;
  status: 'available' | 'unavailable'; reason: string | null;
  minutes: number | null; rosGP: number | null; teamRemaining: number | null;
  stats: (ProjectionStats & { 'FG%': number | null; 'FT%': number | null }) | null;
  shooting?: Record<'2P' | '3P' | 'FT', { attempts: number; percentage: number }>;
  role: { score: number; strength: number; labels: string[]; teamChange: boolean; newTeamGames: number };
  confidence: 'low' | 'medium' | 'high'; uncertainty: string[]; injuryStatus: string | null;
  generatedAt: string; asOf: string; totalZ: number | null; rank: number | null;
}
export interface ROSSnapshot {
  schemaVersion: 1; modelVersion: number; season: '2026-27'; kind: 'projected-ros'; unit: 'perGame';
  asOf: string; generatedAt: string; refreshedAt: string;
  sources: { season: string; url: string; sha256: string }[];
  positionReport: { verified: number; unresolved: number; mismatches: unknown[] };
  players: ROSPlayer[];
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const timestamp = (v: unknown): v is string => typeof v === 'string' && /T.*(Z|\+00:00)$/.test(v) && Number.isFinite(Date.parse(v));
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
export function parseEligibility(v: unknown): FantasyEligibility {
  if (!obj(v) || typeof v.playerId !== 'string' || !/^\d+$/.test(v.playerId) || v.season !== '2026-27'
    || !strings(v.positions) || new Set(v.positions).size !== v.positions.length || v.positions.some(p => !fantasyPositions.includes(p as FantasyPosition))
    || !['verified', 'unresolved'].includes(String(v.status)) || (v.status === 'verified') !== (v.positions.length > 0)
    || (v.name !== undefined && (typeof v.name !== 'string' || !v.name.trim()))
    || !['provider', 'source'].every(k => typeof v[k] === 'string' && v[k]) || !timestamp(v.retrievedAt)) throw new Error('Fantasy pozisyon kaydı doğrulanamadı.');
  return v as unknown as FantasyEligibility;
}
export function parseFantasyCatalog(v: unknown): FantasyEligibility[] {
  if (!obj(v) || v.schemaVersion !== 1 || v.season !== '2026-27' || !Array.isArray(v.players)) throw new Error('Fantasy katalog doğrulanamadı.');
  const rows = v.players.map(parseEligibility);
  if (rows.some(r => typeof r.name !== 'string' || !r.name.trim())) throw new Error('Fantasy katalog oyuncu adı eksik.');
  if (new Set(rows.map(r => r.playerId)).size !== rows.length) throw new Error('Mükerrer ESPN kimliği.');
  return rows;
}
/** Independent network boundary. Never trust a central source as a manual file. */
export function parseProjections(v: unknown, requireRanks = true): ROSSnapshot {
  const invalid = (): never => { throw new Error('ROS projeksiyon dosyası doğrulanamadı.'); };
  if (!obj(v) || v.schemaVersion !== 1 || v.modelVersion !== 1 || v.season !== '2026-27' || v.kind !== 'projected-ros' || v.unit !== 'perGame'
    || !day(v.asOf) || !timestamp(v.generatedAt) || !timestamp(v.refreshedAt) || v.generatedAt !== v.refreshedAt
    || !Array.isArray(v.players) || !Array.isArray(v.sources) || v.sources.length < 4 || !obj(v.positionReport)) return invalid();
  for (const source of v.sources) if (!obj(source) || typeof source.url !== 'string' || !source.url.startsWith('https://') || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) || typeof source.season !== 'string') return invalid();
  const ids = new Set<string>();
  for (const p of v.players) {
    if (!obj(p) || typeof p.id !== 'string' || !/^\d+$/.test(p.id) || ids.has(p.id) || !['name', 'team'].every(k => typeof p[k] === 'string' && p[k])
      || !['available', 'unavailable'].includes(String(p.status)) || !['low', 'medium', 'high'].includes(String(p.confidence))
      || !strings(p.uncertainty) || !obj(p.role) || typeof p.role.score !== 'number' || !Number.isFinite(p.role.score) || Math.abs(p.role.score) > 1
      || !num(p.role.strength) || p.role.strength > 1 || !strings(p.role.labels) || typeof p.role.teamChange !== 'boolean' || !num(p.role.newTeamGames)
      || p.asOf !== v.asOf || p.generatedAt !== v.generatedAt || !(p.injuryStatus === null || typeof p.injuryStatus === 'string')) return invalid();
    if (p.experience !== undefined && !experienceClasses.includes(p.experience as typeof experienceClasses[number])
      || p.projectionBasis !== undefined && p.projectionBasis !== null && !projectionBases.includes(p.projectionBasis as typeof projectionBases[number])
      || p.verifiedSourceDate !== undefined && p.verifiedSourceDate !== null && !timestamp(p.verifiedSourceDate)
      || p.draftIdentityVerified !== undefined && typeof p.draftIdentityVerified !== 'boolean'
      || p.nbaEntryVerified !== undefined && typeof p.nbaEntryVerified !== 'boolean'
      || p.experienceReason !== undefined && p.experienceReason !== null && typeof p.experienceReason !== 'string') return invalid();
    const eligibility = parseEligibility(p.eligibility);
    if (eligibility.playerId !== p.id || JSON.stringify(p.positions) !== JSON.stringify(eligibility.positions)) return invalid();
    ids.add(p.id);
    if (!(p.rosGP === null || num(p.rosGP)) || !(p.teamRemaining === null || num(p.teamRemaining) && Number.isInteger(p.teamRemaining) && p.teamRemaining <= 82)
      || (p.rosGP !== null && (p.teamRemaining === null || (p.rosGP as number) > (p.teamRemaining as number)))) return invalid();
    if (p.status === 'available') {
      if (!num(p.minutes) || p.minutes > 48 || !obj(p.stats) || !obj(p.shooting)) return invalid();
      const s = p.stats;
      if (PROJECTION_STATS.some(k => !num(s[k]))) return invalid();
      const a = s as unknown as ProjectionStats;
      for (const k of ['2P', '3P', 'FT']) {
        const shot = p.shooting[k];
        if (!obj(shot) || !num(shot.attempts) || !num(shot.percentage) || shot.percentage > 1) return invalid();
      }
      const shots = p.shooting as unknown as NonNullable<ROSPlayer['shooting']>;
      if (a.FGM > a.FGA || a.FTM > a.FTA || a['3PM'] > a.FGM || a['3PM'] > shots['3P'].attempts
        || !close(a.PTS, 2 * a.FGM + a['3PM'] + a.FTM)
        || !close(a.FGA, shots['2P'].attempts + shots['3P'].attempts)
        || !close(a['3PM'], shots['3P'].attempts * shots['3P'].percentage)
        || !close(a.FGM, shots['2P'].attempts * shots['2P'].percentage + a['3PM'])
        || !close(a.FTA, shots.FT.attempts) || !close(a.FTM, a.FTA * shots.FT.percentage)) return invalid();
      for (const [pct, made, attempts] of [['FG%', a.FGM, a.FGA], ['FT%', a.FTM, a.FTA]] as const) {
        if (attempts === 0 ? s[pct] !== null : !num(s[pct]) || !close(s[pct] as number, made / attempts * 100)) return invalid();
      }
      if (requireRanks && (!Number.isInteger(p.rank) || (p.rank as number) < 1 || typeof p.totalZ !== 'number' || !Number.isFinite(p.totalZ))) return invalid();
    } else if (p.stats !== null || p.minutes !== null || p.rank !== null || p.totalZ !== null || typeof p.reason !== 'string' || !p.reason) return invalid();
  }
  const snapshot = v as unknown as ROSSnapshot;
  if (snapshot.positionReport.verified !== snapshot.players.filter(p => p.positions.length).length || snapshot.positionReport.unresolved !== snapshot.players.filter(p => !p.positions.length).length || !Array.isArray(snapshot.positionReport.mismatches)) return invalid();
  if (requireRanks) {
    const ranked = rankProjections(snapshot);
    for (let i = 0; i < snapshot.players.length; i++) {
      const p = snapshot.players[i]!, r = ranked.players[i]!;
      if (p.rank !== r.rank || p.totalZ !== null && !close(p.totalZ, r.totalZ!)) return invalid();
    }
  }
  return snapshot;
}
export function rankProjections(snapshot: ROSSnapshot): ROSSnapshot {
  const inputs: StatsPlayer[] = snapshot.players.filter(p => p.status === 'available').map(p => ({
    id: p.id, name: p.name, team: p.team, position: p.positions.join('/'), gp: p.rosGP ?? 0,
    stats: p.stats!, totals: p.stats!,
  }));
  const ranked = new Map(playerZScores(inputs).players.map(p => [p.id, p]));
  return { ...snapshot, players: snapshot.players.map(p => ({ ...p, totalZ: ranked.get(p.id)?.totalZ ?? null, rank: ranked.get(p.id)?.rank ?? null })) };
}
