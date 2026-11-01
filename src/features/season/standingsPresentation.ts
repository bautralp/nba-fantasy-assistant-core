import type { LeagueTeam } from './model.ts';
import { compareNames } from './seasonOrdering.ts';
function recordValues(team: LeagueTeam) {
  const record = team.record;
  if (!record || ![record.wins, record.losses, record.ties].every(n => n !== null && Number.isSafeInteger(n) && n >= 0)) return null;
  return { wins: record.wins!, losses: record.losses!, ties: record.ties! };
}
export function standingsRows(teams: readonly LeagueTeam[]) {
  const rows = teams.map(team => {
    const record = recordValues(team);
    const played = record ? record.wins + record.losses + record.ties : null;
    const credit = record ? record.wins * 2 + record.ties : 0;
    return { team, played, credit, winPercentage: played ? credit / (2 * played) : null, rank: null as number | null, tied: false };
  });
  // Compare exact integer fractions. Alphabetical order never changes an equal percentage's rank.
  rows.sort((a, b) => {
    if (a.winPercentage === null || b.winPercentage === null) return Number(a.winPercentage === null) - Number(b.winPercentage === null) || compareNames(a.team.name, b.team.name) || a.team.espnTeamId - b.team.espnTeamId;
    return b.credit * a.played! - a.credit * b.played! || compareNames(a.team.name, b.team.name) || a.team.espnTeamId - b.team.espnTeamId;
  });
  rows.forEach((row, index) => {
    if (row.winPercentage === null) return;
    const previous = rows[index - 1];
    const equal = previous?.winPercentage !== null && previous !== undefined && row.credit * previous.played! === previous.credit * row.played!;
    row.rank = equal ? previous.rank : index + 1;
    if (equal) { previous.tied = true; row.tied = true; }
  });
  return rows;
}
export const standingsPercentage = (value: number | null) => value === null ? '—' : `${(value * 100).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
