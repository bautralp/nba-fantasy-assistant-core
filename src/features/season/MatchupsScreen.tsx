import { useState } from 'react';
import type { PublicLeague } from './model.ts';
import { scheduleWeeks } from './leaguePresentation.ts';
import { prioritizeMatchups } from './seasonOrdering.ts';
import { MatchupCard } from './MatchupCard.tsx';
export function MatchupsScreen({ league, teamId, schedule = false }: { league: PublicLeague; teamId: number; schedule?: boolean }) {
  const weeks = scheduleWeeks(league);
  const [selected, setSelected] = useState(league.matchupPeriodId);
  const week = schedule ? selected : league.matchupPeriodId;
  const index = week === null ? -1 : weeks.indexOf(week);
  const matches = prioritizeMatchups(league.matchups?.filter(m => m.matchupPeriodId === week) ?? [], teamId);
  return <>{schedule && <nav className="season-week-nav" aria-label="Fikstür haftaları"><button disabled={index <= 0} onClick={() => setSelected(weeks[index - 1])}>← Önceki hafta</button><label>Hafta<select value={week ?? ''} onChange={e => setSelected(Number(e.target.value))}>{index < 0 && <option value="">Güncel hafta mevcut değil</option>}{weeks.map(w => <option key={w} value={w}>{w}. hafta{w === league.matchupPeriodId ? ' · Güncel' : ''}</option>)}</select></label><button disabled={index < 0 || index >= weeks.length - 1} onClick={() => setSelected(weeks[index + 1])}>Sonraki hafta →</button></nav>}
    <p className="muted" role="status">{week === null ? 'Hafta bilgisi mevcut değil' : `${week}. hafta`}</p>
    {matches.length ? <div className="season-grid matchups-grid">{matches.map((matchup, i) => <MatchupCard key={`${week}-${i}`} league={league} matchup={matchup} teamId={teamId} />)}</div> : <p>Eşleşme verisi mevcut değil.</p>}</>;
}
