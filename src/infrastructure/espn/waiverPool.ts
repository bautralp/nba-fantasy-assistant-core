import { publicProviderFetch } from '../../publicCore/dataAccess.ts';
import { EspnError } from './normalize.ts';
import { leagueUrl, parseLeagueInput } from './client.ts';
import { normalizeDisplayPositions } from '../../features/season/positions.ts';
import type { BasketballPosition } from '../../features/season/model.ts';

/** Read-only anonymous ESPN free-agent/waiver pool (kona_player_info + X-Fantasy-Filter).
 * Never sends cookies, credentials, transactions or claims. */
export type PoolStatus = 'FREEAGENT' | 'WAIVERS';
export interface WaiverPlayer {
  espnPlayerId: number; name: string; proTeamId: number | null; eligibleSlotIds: number[];
  primaryPosition: BasketballPosition | null; displayPositions: BasketballPosition[];
  status: PoolStatus; waiverProcessDate: string | null; injuryStatus: string | null; percentOwned: number | null;
}
export interface PoolPage { players: WaiverPlayer[]; rejectedOnTeam: number; rejectedInvalid: number; received: number; fetchedAt: string; total?: number | null }
export interface WaiverPool {
  leagueId: number; seasonId: number; fetchedAt: string; players: WaiverPlayer[];
  /** 'end-observed': a short page, or reaching ESPN's reported total, ended the scan.
   * 'truncated': the page budget ran out first; only the most-owned players were read. */
  completeness: 'end-observed' | 'truncated';
  /** ESPN's X-Fantasy-Filter-Player-Count for this filter; null when not sent or not readable. */
  total: number | null;
  pagesRead: number; pageSize: number; duplicates: number; rejectedOnTeam: number; rejectedInvalid: number;
}
// 26 Oct 2026 CI probe: limit 200 is honoured; the 955-player pool ends in 5 pages (~3.6 MB untrimmed).
export const POOL_PAGE_SIZE = 200, POOL_MAX_PAGES = 10, POOL_PAGE_GAP_MS = 250;
export function poolFilter(offset: number, limit: number) {
  return JSON.stringify({ players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit, offset, sortPercOwned: { sortPriority: 1, sortAsc: false },
    // The app never reads ESPN stats (projections come from the central dataset). An unused
    // stat source drops those blocks: ~83% fewer bytes, all fields we read still present.
    filterStatsForSourceIds: { value: [99] } } });
}
function poolTotal(response: Response) {
  const raw = response.headers.get('x-fantasy-filter-player-count'), n = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const id = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;

/** Statuses other than FREEAGENT/WAIVERS, or any owning team, never appear as available. */
export function normalizePoolPage(raw: unknown, fetchedAt: string): PoolPage {
  const r = obj(raw);
  if (!Array.isArray(r.players)) throw new EspnError('validation', 'ESPN oyuncu havuzu beklenmeyen biçimde.');
  let rejectedOnTeam = 0, rejectedInvalid = 0;
  const players: WaiverPlayer[] = [];
  for (const value of r.players) {
    const e = obj(value), p = obj(e.player), pid = id(e.id) ?? id(p.id), name = text(p.fullName);
    const status = e.status, onTeam = e.onTeamId;
    if (onTeam !== undefined && onTeam !== 0 || status === 'ONTEAM') { rejectedOnTeam++; continue; }
    if (pid === null || id(p.id) !== pid || !name || (status !== 'FREEAGENT' && status !== 'WAIVERS') || !Array.isArray(p.eligibleSlots) || p.eligibleSlots.some(s => !Number.isSafeInteger(s) || (s as number) < 0)) { rejectedInvalid++; continue; }
    const slots = p.eligibleSlots as number[], date = typeof e.waiverProcessDate === 'number' && Number.isFinite(e.waiverProcessDate) && e.waiverProcessDate > 0 ? new Date(e.waiverProcessDate).toISOString() : null;
    const owned = obj(p.ownership).percentOwned;
    players.push({ espnPlayerId: pid, name, proTeamId: typeof p.proTeamId === 'number' && Number.isSafeInteger(p.proTeamId) && p.proTeamId >= 0 ? p.proTeamId : null,
      eligibleSlotIds: slots, ...normalizeDisplayPositions(p.defaultPositionId, slots), status, waiverProcessDate: status === 'WAIVERS' ? date : null,
      injuryStatus: text(p.injuryStatus), percentOwned: typeof owned === 'number' && Number.isFinite(owned) && owned >= 0 && owned <= 100 ? owned : null });
  }
  return { players, rejectedOnTeam, rejectedInvalid, received: r.players.length, fetchedAt };
}

async function readJson(response: Response, maxBytes: number) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new EspnError('size', 'ESPN oyuncu havuzu yanıtı boyut sınırını aştı.'); }
  if (!response.body) throw new EspnError('response', 'ESPN boş yanıt gönderdi.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxBytes) throw new EspnError('size', 'ESPN oyuncu havuzu yanıtı boyut sınırını aştı.'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new EspnError('response', 'ESPN geçerli JSON göndermedi.'); }
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});

export function createWaiverPoolClient({ fetcher = publicProviderFetch, now = Date.now, timeoutMs = 12_000, maxBytesPerPage = 4 * 1024 * 1024, pageSize = POOL_PAGE_SIZE, maxPages = POOL_MAX_PAGES, pageGapMs = POOL_PAGE_GAP_MS, cacheMs = 60_000, sleep = wait } = {}) {
  let nextAllowedAt = 0; const cache = new Map<string, WaiverPool>();
  async function readPage(leagueId: number, seasonId: number, offset: number, signal?: AbortSignal): Promise<PoolPage> {
    const url = leagueUrl(leagueId, seasonId, []) + '?view=kona_player_info';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new EspnError('aborted', 'İstek iptal edildi.');
      const controller = new AbortController(); let timedOut = false;
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal, headers: { 'X-Fantasy-Filter': poolFilter(offset, pageSize) } });
        if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new EspnError('private', 'Oyuncu havuzu anonim erişime kapalı. Lig public değilse waiver listesi okunamaz.'); }
        if (response.status === 404) { await response.body?.cancel(); throw new EspnError('not-found', 'Lig bulunamadı veya görünür değil.'); }
        if (response.status === 429) { await response.body?.cancel(); const seconds = Number(response.headers.get('retry-after')); nextAllowedAt = now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 30) * 1000; throw new EspnError('rate-limit', 'ESPN istek sınırına ulaşıldı. Biraz sonra yeniden dene.'); }
        if (response.status >= 500 && attempt === 0) { await response.body?.cancel(); continue; }
        if (!response.ok) { await response.body?.cancel(); throw new EspnError('response', `ESPN isteği başarısız (HTTP ${response.status}).`); }
        const page = normalizePoolPage(await readJson(response, maxBytesPerPage), new Date(now()).toISOString());
        if (controller.signal.aborted) throw new Error('aborted');
        return { ...page, total: poolTotal(response) };
      } catch (e) {
        if (timedOut) throw new EspnError('timeout', 'ESPN isteği zaman aşımına uğradı. Yeniden dene.');
        if (signal?.aborted) throw new EspnError('aborted', 'İstek iptal edildi.');
        if (e instanceof EspnError) throw e;
        throw new EspnError('network', 'ESPN oyuncu havuzuna bağlanılamadı. Ağ veya tarayıcı CORS kısıtlaması olabilir.');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    throw new EspnError('response', 'ESPN isteği tamamlanamadı.');
  }
  return { async load(leagueId: number, seasonId: number, { refresh = false, signal, notOlderThan }: { refresh?: boolean; signal?: AbortSignal; notOlderThan?: string } = {}): Promise<WaiverPool> {
    parseLeagueInput(String(leagueId), seasonId);
    const key = `${leagueId}:${seasonId}`, cached = cache.get(key);
    // A newer league snapshot must not be paired with an older pool read.
    if (!refresh && cached && now() - Date.parse(cached.fetchedAt) < cacheMs && !(notOlderThan && Date.parse(cached.fetchedAt) < Date.parse(notOlderThan) - cacheMs)) return cached;
    if (now() < nextAllowedAt) throw new EspnError('rate-limit', 'Çok sık yenileme yapılıyor. Biraz bekleyip yeniden dene.');
    const seen = new Map<number, WaiverPlayer>(); let duplicates = 0, rejectedOnTeam = 0, rejectedInvalid = 0, pagesRead = 0, fetchedAt = '', ended = false, total: number | null = null;
    // Pages are read one at a time with a short pause; ESPN's 429 stops the scan (see readPage).
    for (let page = 0, offset = 0; page < maxPages; page++) {
      if (page > 0) { await sleep(pageGapMs, signal); if (signal?.aborted) throw new EspnError('aborted', 'İstek iptal edildi.'); }
      const result = await readPage(leagueId, seasonId, offset, signal);
      pagesRead++; fetchedAt ||= result.fetchedAt; rejectedOnTeam += result.rejectedOnTeam; rejectedInvalid += result.rejectedInvalid;
      total = result.total ?? total; offset += result.received;
      for (const p of result.players) { if (seen.has(p.espnPlayerId)) duplicates++; else seen.set(p.espnPlayerId, p); }
      // Reaching ESPN's reported total ends the pool (no empty extra request). Without a total,
      // a short page ends it. A short page below the total means ESPN capped the page: continue.
      if (total !== null ? offset >= total || result.received === 0 : result.received < pageSize) { ended = true; break; }
    }
    const pool: WaiverPool = { leagueId, seasonId, fetchedAt, players: [...seen.values()], completeness: ended ? 'end-observed' : 'truncated', total, pagesRead, pageSize, duplicates, rejectedOnTeam, rejectedInvalid };
    if (cache.size >= 3) cache.delete(cache.keys().next().value!);
    cache.set(key, pool); return pool;
  } };
}
