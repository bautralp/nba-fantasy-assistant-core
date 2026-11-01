import type { PublicLeague } from './model.ts';
import { EspnError } from '../../infrastructure/espn/client.ts';
export interface SeasonState { league: PublicLeague | null; loading: boolean; error: string | null; stale: boolean }
/** Separate from draft workspace. Generation protects even transports that ignore abort. */
export function createSeasonSession(load: (input: string, season: number, options: { refresh: boolean; signal: AbortSignal }) => Promise<PublicLeague>, changed: (s: SeasonState) => void) {
  let generation = 0, controller: AbortController | undefined;
  let state: SeasonState = { league: null, loading: false, error: null, stale: false };
  return { cancel() { generation++; controller?.abort(); }, async connect(input: string, season: number, refresh = false) {
    const current = ++generation; controller?.abort(); controller = new AbortController();
    state = { ...state, loading: true, error: null }; changed(state);
    try { const league = await load(input, season, { refresh, signal: controller.signal }); if (current !== generation) return; state = { league, loading: false, error: null, stale: false }; }
    catch (e) { if (current !== generation) return; state = { ...state, loading: false, stale: !!state.league, error: e instanceof EspnError ? e.message : 'Lig verileri okunamadı.' }; }
    changed(state);
    return state.error ? null : state.league;
  } };
}
