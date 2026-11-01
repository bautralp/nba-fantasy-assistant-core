import { PowerRankingsScreen } from './PowerRankingsScreen.tsx';
import { TeamAnalysisScreen } from './TeamAnalysisScreen.tsx';
import { WaiverScreen } from './WaiverScreen.tsx';
import { TradeScreen } from './TradeScreen.tsx';
import { ANALYSIS_SCREENS } from './navigation.ts';
import { TeamSelection } from './TeamSelection.tsx';
import { SeasonMenu } from './SeasonMenu.tsx';
import { MatchupsScreen } from './MatchupsScreen.tsx';
import { RostersScreen } from './RostersScreen.tsx';
import { StandingsScreen } from './StandingsScreen.tsx';
import { useSeasonAssistant } from './useSeasonAssistant.ts';
import './season.css';

export function SeasonAssistant() {
  const view = useSeasonAssistant();
  const { league, team, screen, state } = view;
  return <section className="panel season-assistant" aria-label="ESPN sezon içi bağlantısı">
    <h2 id="page-heading" tabIndex={-1} ref={view.heading}>{view.title}</h2>
    {view.connecting && <>
      <p className="muted">Public ESPN ligini bağlayarak başla.</p>
      <form className="season-connect" onSubmit={e => { e.preventDefault(); void view.connect(); }}>
        <label>ESPN League ID veya lig URL’si
          <input value={view.input} onChange={e => view.setInput(e.target.value)} required autoComplete="off" />
        </label>
        <label>Sezon (bitiş yılı)
          <input type="number" min={2018} max={2100} value={view.season} onChange={e => view.setSeason(Number(e.target.value))} required />
        </label>
        <button className="primary" type="submit" disabled={state.loading}>Ligi bağla</button>
      </form>
    </>}
    {state.loading && (view.connecting || !ANALYSIS_SCREENS.includes(screen)) && <p role="status">ESPN verileri okunuyor…</p>}
    {state.error && (view.connecting || !ANALYSIS_SCREENS.includes(screen)) && <p role="alert">{state.error}</p>}
    {view.preferenceError && <p role="alert">{view.preferenceError}</p>}
    {league && !view.connecting && <>
      <header className="season-league">
        <div>
          <h3>{league.name}</h3>
          {team && screen !== 'teams' && <p>{team.name}</p>}
          <p className="muted">ESPN · <time dateTime={league.fetchedAt}>{new Date(league.fetchedAt).toLocaleString('tr-TR')}</time> · {ANALYSIS_SCREENS.includes(screen) ? 'Lig verisi' : view.stale ? 'Eski veri — yenileme gerekli' : 'Güncel veri'}</p>
        </div>
        {!ANALYSIS_SCREENS.includes(screen) && <button disabled={state.loading} onClick={() => void view.refresh()}>Verileri yenile</button>}
      </header>
      <nav className="actions season-navigation" aria-label="Sezon içi navigasyon">
        {team && screen !== 'menu' && <button onClick={() => view.go('menu')}>← Sezon içi ana menü</button>}
        {screen !== 'teams' && <button onClick={() => view.go('teams')}>Takım değiştir</button>}
        <button onClick={view.changeLeague}>Lig değiştir</button>
      </nav>
      {screen === 'teams' || !team ? <TeamSelection league={league} onSelect={view.select} />
        : screen === 'menu' ? <SeasonMenu onOpen={view.go} />
        : screen === 'weekly' || screen === 'schedule' ? <MatchupsScreen key={`${league.leagueId}:${league.seasonId}:${screen}`} league={league} teamId={team.espnTeamId} schedule={screen === 'schedule'} />
        : screen === 'rosters' ? <RostersScreen league={league} teamId={team.espnTeamId} />
        : screen === 'power' ? <PowerRankingsScreen league={league} teamId={team.espnTeamId} leagueLoading={state.loading} leagueError={!state.loading && (!!state.error || state.stale)} />
        : screen === 'analysis' ? <TeamAnalysisScreen key={`${league.leagueId}:${league.seasonId}:${team.espnTeamId}`} league={league} teamId={team.espnTeamId} leagueLoading={state.loading} leagueError={!state.loading && (!!state.error || state.stale)} />
        : screen === 'waiver' ? <WaiverScreen key={`${league.leagueId}:${league.seasonId}:${team.espnTeamId}`} league={league} teamId={team.espnTeamId} leagueLoading={state.loading} leagueError={!state.loading && (!!state.error || state.stale)} />
        : screen === 'trade' ? <TradeScreen key={`${league.leagueId}:${league.seasonId}:${team.espnTeamId}`} league={league} teamId={team.espnTeamId} leagueLoading={state.loading} leagueError={!state.loading && (!!state.error || state.stale)} />
        : <StandingsScreen league={league} teamId={team.espnTeamId} />}
    </>}
  </section>;
}
