import { useEffect, useState } from 'react';
import { createWaiverPoolClient, type WaiverPool } from '../../infrastructure/espn/waiverPool.ts';
import { EspnError } from '../../infrastructure/espn/normalize.ts';
import type { PublicLeague } from './model.ts';

// One client per page keeps the rate-limit cooldown and 60 s cache shared.
const client = createWaiverPoolClient();
/** Pool reads follow the league snapshot: a new ESPN snapshot re-reads the pool. */
export function useWaiverPool(league: PublicLeague) {
  const [state, setState] = useState<{ fetchedFor: string; pool: WaiverPool | null; error: string }>({ fetchedFor: '', pool: null, error: '' });
  const key = `${league.leagueId}:${league.seasonId}:${league.fetchedAt}`;
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try { const pool = await client.load(league.leagueId, league.seasonId, { signal: controller.signal, notOlderThan: league.fetchedAt }); if (!controller.signal.aborted) setState({ fetchedFor: key, pool, error: '' }); }
      catch (e) { if (!controller.signal.aborted) setState({ fetchedFor: key, pool: null, error: e instanceof EspnError ? e.message : 'Oyuncu havuzu okunamadı.' }); }
    });
    return () => controller.abort();
  }, [key, league.leagueId, league.seasonId]);
  const current = state.fetchedFor === key;
  return { pool: current ? state.pool : null, error: current ? state.error : '', loading: !current };
}
