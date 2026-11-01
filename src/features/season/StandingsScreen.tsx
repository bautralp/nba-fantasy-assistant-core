import type { PublicLeague } from './model.ts';
import { standingsRows, standingsPercentage } from './standingsPresentation.ts';
export function StandingsScreen({ league, teamId }: { league: PublicLeague; teamId: number }) {
  const rows = standingsRows(league.teams);
  const showGamesBack = rows.some(row => !!row.played && row.team.gamesBack !== null);
  return <div className="standings-scroll" role="region" aria-label="Lig sıralaması tablosu" tabIndex={0}>
    <table className="season-standings-table">
      <caption>Hesaplanan geçici sıralama · Kaynak: ESPN W/L/T</caption>
      <thead><tr><th scope="col">Sıra</th><th scope="col">Takım</th><th scope="col">Oynanan</th><th scope="col"><abbr title="Galibiyet">G</abbr></th><th scope="col"><abbr title="Mağlubiyet">M</abbr></th><th scope="col"><abbr title="Beraberlik">B</abbr></th><th scope="col" aria-sort={rows.some(r => r.rank !== null) ? 'descending' : undefined}>W%</th>{showGamesBack && <th scope="col"><abbr title="ESPN games back">GB</abbr></th>}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.team.espnTeamId} className={row.team.espnTeamId === teamId ? 'is-mine' : undefined}>
        <td>{row.rank ?? '—'}{row.tied && <><span aria-hidden="true"> =</span><span className="sr-only"> (Eşit sıra)</span></>}</td>
        <th scope="row" className="standings-team"><span>{row.team.name}</span>{row.team.espnTeamId === teamId && <span className="season-badge">Benim takımım</span>}</th>
        <td>{row.played ?? '—'}</td><td>{row.team.record?.wins ?? '—'}</td><td>{row.team.record?.losses ?? '—'}</td><td>{row.team.record?.ties ?? '—'}</td>
        <td>{standingsPercentage(row.winPercentage)}</td>{showGamesBack && <td>{row.played ? row.team.gamesBack ?? '—' : '—'}</td>}
      </tr>)}</tbody>
    </table>
  </div>;
}
