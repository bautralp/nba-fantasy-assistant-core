import { useEffect, useRef, useState } from 'react';
import { createEspnClient, CACHE_MS } from '../../infrastructure/espn/client.ts';
import { createSeasonSession } from './session.ts';
import type { SeasonState } from './session.ts';
import { ANALYSIS_SCREENS, preferenceKey, readPreferences, seasonModules, teamPreferenceKey } from './navigation.ts';
import type { SeasonScreen } from './navigation.ts';
export function useSeasonAssistant() {
  const [prefs] = useState(readPreferences), [input, setInput] = useState(prefs.input), [season, setSeason] = useState(prefs.season);
  const [state, setState] = useState<SeasonState>({ league: null, loading: false, error: null, stale: false });
  const [screen, setScreen] = useState<SeasonScreen>('teams'), [selection, setSelection] = useState<{ key: string; id: number } | null>(null);
  const [connecting, setConnecting] = useState(true), [preferenceError, setPreferenceError] = useState(''), [clock, setClock] = useState(Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const session = useRef<ReturnType<typeof createSeasonSession> | null>(null);
  if (!session.current) { const client = createEspnClient(); session.current = createSeasonSession((i, s, o) => client.load(i, s, o), setState); }
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 15_000); return () => { clearInterval(timer); session.current?.cancel(); }; }, []);
  const league = state.league, scope = league ? teamPreferenceKey(league.leagueId, league.seasonId) : '';
  const team = league && selection?.key === scope ? league.teams.find(t => t.espnTeamId === selection.id) : undefined;
  const stale = state.stale || !!league && clock - Date.parse(league.fetchedAt) >= CACHE_MS;
  useEffect(() => {
    if (!league) return;
    setConnecting(false);
    try {
      sessionStorage.setItem(preferenceKey, JSON.stringify({ input: String(league.leagueId), season: league.seasonId }));
      const stored = sessionStorage.getItem(teamPreferenceKey(league.leagueId, league.seasonId));
      const id = stored === null ? null : Number(stored);
      if (id !== null && league.teams.some(t => t.espnTeamId === id)) { setSelection({ key: teamPreferenceKey(league.leagueId, league.seasonId), id }); setScreen('menu'); }
      else { setSelection(null); setScreen('teams'); }
      setPreferenceError('');
    } catch { setSelection(null); setScreen('teams'); setPreferenceError('Tercihler kaydedilemedi; bu oturumda devam edebilirsiniz.'); }
  }, [league?.leagueId, league?.seasonId]);
  useEffect(() => { heading.current?.focus(); }, [screen, connecting, league?.leagueId]);
  const go = (next: SeasonScreen) => {
    // Cache TTL decides whether to fetch on entry, never whether computed ranks
    // remain valid while the user is reading them. Session owns ordering/abort.
    if (ANALYSIS_SCREENS.includes(next) && league && !state.loading &&
      (state.stale || Date.now() - Date.parse(league.fetchedAt) >= CACHE_MS)) {
      void session.current!.connect(String(league.leagueId), league.seasonId, state.stale);
    }
    setScreen(next);
  };
  const select = (id: number) => {
    setSelection({ key: scope, id }); go('menu');
    try { sessionStorage.setItem(scope, String(id)); setPreferenceError(''); } catch { setPreferenceError('Takım tercihi kaydedilemedi; bu oturumda devam edebilirsiniz.'); }
  };
  const changeLeague = () => { session.current?.cancel(); setState(s => ({ ...s, loading: false, error: null })); setConnecting(true); };
  const connect = () => session.current!.connect(input, season).then(result => { if (result) setConnecting(false); });
  const refresh = () => session.current!.connect(String(league!.leagueId), league!.seasonId, true);
  const title = connecting ? 'Sezon İçi Asistanı' : screen === 'teams' || !team ? 'Takımını seç' : screen === 'menu' ? 'Sezon İçi Asistanı' : seasonModules.find(m => m.screen === screen)?.title;
  return { input, setInput, season, setSeason, state, screen, connecting, preferenceError, heading, league, team, stale, title, go, select, connect, refresh, changeLeague };
}
