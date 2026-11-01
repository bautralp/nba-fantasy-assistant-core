import type { PublicLeague } from './model.ts';
export function TeamSelection({ league, onSelect }: { league: PublicLeague; onSelect: (id: number) => void }) {
  return <><p>Kendi takımınızı seçmek için üzerine tıklayınız.</p><div className="season-grid team-selection">{league.teams.map(team => <button className="main-card" key={team.espnTeamId} onClick={() => onSelect(team.espnTeamId)}>{team.name}</button>)}</div></>;
}
