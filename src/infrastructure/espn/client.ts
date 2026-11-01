import { publicProviderFetch } from '../../publicCore/dataAccess.ts';
import type { PublicLeague } from '../../features/season/model.ts';
import { EspnError, normalizeLeague } from './normalize.ts';
export { EspnError } from './normalize.ts';
export const ESPN_VIEWS = ['mSettings', 'mTeam', 'mRoster', 'mMatchupScore', 'mStatus', 'mStandings', 'mBoxscore'] as const;
export const CACHE_MS = 60_000;
export function parseLeagueInput(input: string, season: number): { leagueId: number; seasonId: number } {
  if (!Number.isInteger(season) || season < 2018 || season > 2100) throw new EspnError('input', 'Sezon 2018–2100 arasında bir ESPN sezon bitiş yılı olmalı.');
  let id = input.trim();
  if (!/^\d+$/.test(id)) {
    try { const url = new URL(id); if (url.protocol !== 'https:' || url.hostname !== 'fantasy.espn.com' || !url.pathname.startsWith('/basketball/') || url.username || url.password) throw Error();
      if (url.searchParams.has('seasonId') && url.searchParams.get('seasonId') !== String(season)) throw new EspnError('input', 'Lig URL’sindeki sezon ile seçilen sezon farklı.');
      id = url.searchParams.get('leagueId') ?? '';
    } catch (e) { if (e instanceof EspnError) throw e; throw new EspnError('input', 'Geçerli ESPN Basketball lig URL’si veya sayısal League ID gir.'); }
  }
  const leagueId = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(leagueId) || leagueId <= 0) throw new EspnError('input', 'League ID pozitif bir tam sayı olmalı.');
  return { leagueId, seasonId: season };
}
export function leagueUrl(leagueId: number, seasonId: number, views: readonly string[] = ESPN_VIEWS) {
  parseLeagueInput(String(leagueId), seasonId);
  const url = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${seasonId}/segments/0/leagues/${leagueId}`);
  for (const view of views) { if (!(ESPN_VIEWS as readonly string[]).includes(view)) throw new EspnError('input', 'Desteklenmeyen ESPN view.'); url.searchParams.append('view', view); }
  return url.toString();
}
async function readJson(response: Response, maxBytes: number) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new EspnError('size', 'ESPN yanıtı boyut sınırını aştı.'); }
  if (!response.body) throw new EspnError('response', 'ESPN boş yanıt gönderdi.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxBytes) throw new EspnError('size', 'ESPN yanıtı boyut sınırını aştı.'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new EspnError('response', 'ESPN geçerli JSON göndermedi.'); }
}
export function createEspnClient({ fetcher = publicProviderFetch, now = Date.now, timeoutMs = 12_000, maxBytes = 5 * 1024 * 1024, minIntervalMs = 2000 } = {}) {
  const cache = new Map<string, PublicLeague>(); let nextAllowedAt = 0;
  return { async load(input: string, season: number, { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PublicLeague> {
    const { leagueId, seasonId } = parseLeagueInput(input, season), url = leagueUrl(leagueId, seasonId), cached = cache.get(url);
    if (signal?.aborted) throw new EspnError('aborted', 'İstek iptal edildi.');
    if (!refresh && cached && now() - Date.parse(cached.fetchedAt) < CACHE_MS) return cached;
    if (now() < nextAllowedAt) throw new EspnError('rate-limit', 'Çok sık yenileme yapılıyor. Biraz bekleyip yeniden dene.');
    nextAllowedAt = now() + minIntervalMs;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new EspnError('aborted', 'İstek iptal edildi.');
      const controller = new AbortController(); let timedOut = false;
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal });
        if (!response.ok && response.status < 500) await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new EspnError('private', 'Lig private veya anonim erişime kapalı. Public görünürlüğü kontrol et.');
        if (response.status === 404) throw new EspnError('not-found', 'Lig bulunamadı veya görünür değil. League ID, sezon ve public ayarını kontrol et.');
        if (response.status === 429) { const seconds = Number(response.headers.get('retry-after')); nextAllowedAt = now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 30) * 1000; throw new EspnError('rate-limit', 'ESPN istek sınırına ulaşıldı. Daha sonra yenile.'); }
        if (response.status >= 500 && attempt === 0) { await response.body?.cancel(); continue; }
        if (!response.ok) { await response.body?.cancel(); throw new EspnError('response', `ESPN isteği başarısız (HTTP ${response.status}).`); }
        const league = normalizeLeague(await readJson(response, maxBytes), leagueId, seasonId, new Date(now()).toISOString());
        if (controller.signal.aborted) throw new Error('aborted');
        if (cache.size >= 5) cache.delete(cache.keys().next().value!);
        cache.set(url, league); return league;
      } catch (e) {
        if (timedOut) throw new EspnError('timeout', 'ESPN isteği zaman aşımına uğradı. Yeniden dene.');
        if (signal?.aborted) throw new EspnError('aborted', 'İstek iptal edildi.');
        if (e instanceof EspnError) throw e;
        throw new EspnError('network', 'ESPN bağlantısı kurulamadı. Ağ veya tarayıcı CORS kısıtlaması olabilir.');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    throw new EspnError('response', 'ESPN isteği tamamlanamadı.');
  } };
}
