import { useEffect, useMemo, useState } from 'react';
import { loadPowerRankings } from '../../seasonAnalysis/loadPowerRankings.ts';
import { createLeagueEvaluator, type LeagueEvaluator } from '../../seasonAnalysis/analyzeLeague.ts';
import type { PublicLeague } from './model.ts';

export type SeasonSources = Awaited<ReturnType<typeof loadPowerRankings>>;
const REUSE_MS = 10 * 60_000;
let shared: { startedAt: number; promise: Promise<SeasonSources> } | null = null;
/** One validated publication for Team Analysis, Waiver and Trade (the Power Rankings
 * pipeline). Successful loads are reused briefly; failures are never cached. */
export function loadSeasonSources(base: string, now = Date.now()): Promise<SeasonSources> {
  if (shared && now - shared.startedAt < REUSE_MS) return shared.promise;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  const promise = loadPowerRankings(base, controller.signal, now).finally(() => clearTimeout(timer));
  const entry = { startedAt: now, promise };
  shared = entry;
  promise.catch(() => { if (shared === entry) shared = null; });
  return promise;
}
export function resetSeasonSourcesForTests() { shared = null; }

export function useSeasonSources() {
  const [sources, setSources] = useState<SeasonSources | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    // StrictMode's discarded effect resolves after cleanup and is ignored.
    void Promise.resolve().then(async () => {
      if (!active) return;
      try { const data = await loadSeasonSources(import.meta.env.BASE_URL); if (active) setSources(data); }
      catch (e) {
        if (!active) return;
        console.error('Season sources load failed', e);
        const unavailable = e instanceof TypeError || e instanceof DOMException || e instanceof Error && /alınamadı|HTTP/.test(e.message);
        setError(unavailable ? 'Kalan sezon verileri şu anda yüklenemedi.' : 'Güncel kalan sezon verileri henüz hazır değil.');
      }
    });
    return () => { active = false; };
  }, []);
  return { sources, error };
}
/** League rules, schedule and projections are validated once per ESPN snapshot. */
export function useLeagueEvaluator(league: PublicLeague, sources: SeasonSources | null): LeagueEvaluator | null {
  return useMemo(() => sources ? createLeagueEvaluator({ league, ...sources, lineupPolicy: 'daily-max-games' }) : null, [league, sources]);
}
