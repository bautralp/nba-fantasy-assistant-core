import type { PublicLeague } from './model.ts';
import { eligiblePositions } from './leaguePresentation.ts';
import { prioritizeTeams, orderRoster } from './seasonOrdering.ts';
export function RostersScreen({ league, teamId }: { league: PublicLeague; teamId: number }) {
  return <div className="season-grid season-roster-grid">{prioritizeTeams(league.teams, teamId).map(team => <article key={team.espnTeamId} className={`season-card season-roster-card${team.espnTeamId === teamId ? ' is-mine' : ''}`}>
    <header className="season-roster-heading"><h4>{team.name}</h4>{team.espnTeamId === teamId && <span className="season-badge">Benim takımım</span>}</header>
    {team.roster === null ? <p>Kadro verisi mevcut değil.</p> : team.roster.length === 0 ? <p>Kadro boş.</p> : <ul className="season-roster">{orderRoster(team.roster).map(player => <li key={player.espnPlayerId}><strong>{player.name}</strong><span className="roster-positions">{eligiblePositions(player)}</span></li>)}</ul>}
  </article>)}</div>;
}
