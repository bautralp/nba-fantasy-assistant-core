import { PROJECTION_STATS, type DataUnit, type ProjectionStats } from '../domain/models/projection.ts';
import { POSITIONS, type Position } from '../domain/models/roster.ts';

export const HEADERS = ['PLAYER_ID', 'PLAYER', 'POS', 'RANK', 'GP', ...PROJECTION_STATS] as const;
export interface RawFile { name: string; format: 'xlsx' | 'csv' | 'json'; headers: string[]; rows: unknown[][]; season?: unknown; unit?: unknown; schemaVersion?: unknown }
export interface ImportIssue { level: 'file' | 'row' | 'warning' | 'identity'; row?: number; field?: string; message: string }
export interface NormalizedRow { row: number; externalId: string; identityError?: string; name: string; presentation?: { team?: string; mpg?: number }; positions: Position[]; rank?: number; gamesPlayed: number | null; stats: ProjectionStats; issues: ImportIssue[] }
export interface NormalizedFile { name: string; format: RawFile['format']; season: string; unit: DataUnit; rowCount: number; rows: NormalizedRow[]; issues: ImportIssue[] }
export class ImportError extends Error {}
const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: Record<string, string[]> = {
  PLAYER_ID: ['playerid', 'id'], PLAYER: ['player', 'playername', 'oyuncu', 'oyuncuadi', 'name', 'fullname', 'playerfull', 'players'],
  TEAM: ['team', 'takim'], MPG: ['mpg', 'minutespergame'],
  GP: ['gp', 'g', 'games', 'gamesplayed', 'projectedgames', 'projgp', 'gms'],
  FGM: ['fgm', 'fgmade', 'fieldgoalsmade'], FGA: ['fga', 'fgattempts', 'fieldgoalsattempted'],
  FTM: ['ftm', 'ftmade', 'freethrowsmade'], FTA: ['fta', 'ftattempts', 'freethrowsattempted'],
  '3PM': ['3pm', '3ptm', '3p', 'fg3m', 'threes', 'threepointersmade', 'tpm'],
  PTS: ['pts', 'points', 'point'], REB: ['reb', 'rebs', 'trb', 'rebounds'], AST: ['ast', 'assists'],
  STL: ['stl', 'steals'], BLK: ['blk', 'blocks'], TO: ['to', 'tov', 'turnovers', 'turnover'],
  RANK: ['rank', 'ranking', 'espnrank', 'draftposition'], POS: ['pos', 'position', 'positions', 'eligiblepositions'],
  UNIT: ['unit', 'mode', 'dataunit'], SEASON: ['season'], SCHEMA: ['schemaversion'],
};
export function canonical(s: string): string { return Object.keys(aliases).find(k => aliases[k].includes(norm(s))) ?? s.trim().toUpperCase(); }
export const cellText = (v: unknown): string => typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
/** Numeric 1 and text "1" share an identity. Text remains opaque: "001" is distinct
 * from "1" (including legacy whitespace). Never coerce large text IDs to Number.
 */
export function playerIdCell(value: unknown): { value: string; error?: string } {
  if (value === undefined || value === null || value === '') return { value: '' };
  if (typeof value === 'string' && value.trim()) return { value };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { value: String(value) };
  return { value: '', error: 'PLAYER_ID metin veya güvenli pozitif tam sayı olmalı (en fazla 9007199254740991). Büyük kimlikleri metin hücresi olarak girin; geçersiz satırı düzeltin veya açıkça dışarıda bırakın.' };
}
/** Verify the source decimal before IEEE-754 rounding can turn a fraction into an ID. */
export function exactNumericIdSource(source: string): boolean {
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  const normalized = (text: string): string | null => {
    const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (!match) return null;
    const fraction = match[2] ?? '';
    let digits = (match[1] + fraction).replace(/^0+/, '');
    const trailing = digits.length - digits.replace(/0+$/, '').length;
    digits = digits.slice(0, digits.length - trailing);
    return `${digits}:${Number(match[3] ?? 0) - fraction.length + trailing}`;
  };
  return normalized(source) === normalized(String(value));
}
/** Only unambiguous decimal notation. No locale/grouping guessing, booleans or formulas. */
export function numberCell(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string' || !/^\d+(?:\.\d+)?$/.test(v.trim())) return null;
  const n = Number(v.trim()); return Number.isFinite(n) ? n : null;
}
export function normalizeFile(raw: RawFile, metadata: { season?: string; unit?: string } = {}): NormalizedFile {
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 && raw.schemaVersion !== '1') throw new ImportError('Desteklenmeyen şema sürümü.');
  const headers = raw.headers.map(canonical);
  if (new Set(headers).size !== headers.length) throw new ImportError('Mükerrer veya çelişkili sütun başlıkları.');
  const missing = ['PLAYER', 'GP', ...PROJECTION_STATS].filter(k => !headers.includes(k));
  if (missing.length) throw new ImportError(`Eksik zorunlu sütun: ${missing.join(', ')}`);
  const units = new Set<unknown>([raw.unit, ...raw.rows.map(r => r[headers.indexOf('UNIT')])].filter(v => v !== undefined && v !== null && v !== ''));
  const seasons = new Set<unknown>([raw.season, ...raw.rows.map(r => r[headers.indexOf('SEASON')])].filter(v => v !== undefined && v !== null && v !== ''));
  const schemas = raw.rows.map(r => r[headers.indexOf('SCHEMA')]).filter(v => v !== undefined && v !== null && v !== '');
  if (schemas.some(v => v !== 1 && v !== '1')) throw new ImportError('Desteklenmeyen satır şeması.');
  if (units.size > 1 || [...units].some(v => v !== 'perGame' && v !== 'totals')) throw new ImportError('Çelişkili veya desteklenmeyen veri birimi.');
  if (seasons.size > 1 || [...seasons].some(v => typeof v !== 'string' || !v.trim())) throw new ImportError('Çelişkili sezon.');
  const unit = [...units][0] ?? metadata.unit; const season = [...seasons][0] ?? metadata.season;
  if (unit !== 'perGame' && unit !== 'totals') throw new ImportError('Veri birimini açıkça seçin.');
  if (typeof season !== 'string' || !season.trim()) throw new ImportError('Sezonu açıkça girin.');
  if (metadata.unit && units.size && metadata.unit !== unit || metadata.season && seasons.size && metadata.season !== season) throw new ImportError('Dosya metaverisi ile girilen bilgiler uyuşmuyor.');
  const issues: ImportIssue[] = [];
  const rows = raw.rows.flatMap((cells, i): NormalizedRow[] => {
    if (!cells.some(v => v !== undefined && v !== null && v !== '')) return [];
    const row = i + 2; const get = (k: string) => cells[headers.indexOf(k)];
    const identity = playerIdCell(get('PLAYER_ID'));
    const externalId = identity.value; const name = cellText(get('PLAYER'));
    const rowIssues: ImportIssue[] = [];
    const add = (level: 'row' | 'warning' | 'identity', field: string, message: string) => rowIssues.push({ level, row, field, message });
    if (identity.error) add('identity', 'PLAYER_ID', identity.error);
    if (!name && !externalId && !identity.error) { issues.push({ level: 'row', row, field: 'PLAYER', message: 'Kullanılabilir kimlik veya ad yok; satır atlandı.' }); return []; }
    if (!name) add('row', 'PLAYER', 'Oyuncu adı eksik.');
    const gp = numberCell(get('GP'));
    if (gp === null || gp <= 0) add('row', 'GP', 'GP pozitif, sonlu bir sayı olmalı.');
    const stats = Object.fromEntries(PROJECTION_STATS.map(k => { const n = numberCell(get(k)); if (n === null) add('row', k, 'Eksik/geçersiz sayı veya formül; negatif ve belirsiz biçimler kabul edilmez.'); return [k, n ?? 0]; })) as unknown as ProjectionStats;
    if (stats.FGM > stats.FGA) add('row', 'FGM', 'FGM, FGA değerini aşamaz.');
    if (stats.FTM > stats.FTA) add('row', 'FTM', 'FTM, FTA değerini aşamaz.');
    const rank = numberCell(get('RANK'));
    if (get('RANK') !== undefined && get('RANK') !== '' && get('RANK') !== null && (rank === null || rank <= 0 || !Number.isSafeInteger(rank))) add('warning', 'RANK', 'Geçersiz RANK kullanılmadı; pozitif tam sayı olmalı.');
    const tokens = cellText(get('POS')).toUpperCase().split(/[,/;\s-]+/).filter(Boolean);
    const positions = [...new Set(tokens.filter((v): v is Position => POSITIONS.includes(v as Position)))];
    if (!tokens.length || tokens.some(v => !POSITIONS.includes(v as Position))) add('warning', 'POS', 'Eksik veya desteklenmeyen pozisyon; bilinmeyen tokenlar kullanılmadı.');
    const team = cellText(get('TEAM')), mpg = numberCell(get('MPG'));
    const presentation = { ...(team ? { team } : {}), ...(mpg !== null ? { mpg } : {}) };
    return [{ row, externalId, ...(Object.keys(presentation).length ? { presentation } : {}), ...(identity.error ? { identityError: identity.error } : {}), name, positions, ...(rank !== null && rank > 0 && Number.isSafeInteger(rank) ? { rank } : {}), gamesPlayed: gp, stats, issues: rowIssues }];
  });
  if (!rows.length) throw new ImportError('Kullanılabilir kimliği olan oyuncu satırı bulunamadı.');
  return { name: raw.name, format: raw.format, season: season.trim(), unit, rowCount: raw.rows.filter(cells => cells.some(v => v !== undefined && v !== null && v !== '')).length, rows, issues };
}
