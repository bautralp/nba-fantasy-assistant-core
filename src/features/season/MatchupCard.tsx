import type { PublicLeague } from './model.ts';
import { matchupCategories, isCategoryScoring, categoryIsReverse, categoryLeader, categoryValue } from './leaguePresentation.ts';
import { matchupScorePresentation } from './matchupScorePresentation.ts';
type Matchup = NonNullable<PublicLeague['matchups']>[number];
export function MatchupCard({ league, matchup, teamId }: { league: PublicLeague; matchup: Matchup; teamId: number }) {
  const { home, away } = matchup;
  const categories = matchupCategories(league);
  const future = league.matchupPeriodId === null || matchup.matchupPeriodId > league.matchupPeriodId;
  const mine = home?.teamId === teamId || away?.teamId === teamId;
  const name = (id: number | undefined) => league.teams.find(t => t.espnTeamId === id)?.name ?? 'Rakip mevcut değil';
  const scores = [home, away].map(s => matchupScorePresentation(league.scoring.type, future ? null : s));
  return <article className={`season-card matchup-card${mine ? ' is-mine' : ''}`} aria-label={`${name(home?.teamId)} – ${name(away?.teamId)}`}>
    <div className="season-card-meta">{mine && <span className="season-badge">Benim eşleşmem</span>}<span>{future ? 'Henüz oynanmadı' : matchup.matchupPeriodId === league.matchupPeriodId ? 'Güncel hafta' : 'Geçmiş hafta'}</span></div>
    <div className="matchup-teams"><h4>{name(home?.teamId)}</h4><span aria-hidden="true">vs</span><h4>{name(away?.teamId)}</h4></div>
    <p className="matchup-score-label">{scores[0].label}</p><div className="matchup-totals"><strong>{scores[0].value}</strong><span aria-hidden="true">–</span><strong>{scores[1].value}</strong></div>
    {categories.length > 0 && <table className="category-comparison"><caption className="sr-only">Kategori karşılaştırması: {name(home?.teamId)} ve {name(away?.teamId)}</caption><thead className="sr-only"><tr><th scope="col">{name(home?.teamId)}</th><th scope="col">Kategori</th><th scope="col">{name(away?.teamId)}</th></tr></thead><tbody>{categories.map(c => {
      const h = future ? undefined : home?.categoryStats?.[c.statId], a = future ? undefined : away?.categoryStats?.[c.statId];
      const leader = categoryLeader(h, a, c.statId, c.isReverse);
      return <tr key={c.statId}><td className={leader === 'home' ? 'category-leading' : ''}>{categoryValue(h, c.statId)}{leader === 'home' && <span className="category-marker"><span aria-hidden="true">▲</span><span className="sr-only">Önde</span></span>}</td><th scope="row">{c.label}{categoryIsReverse(c.statId, c.isReverse) === true && <span className="category-hint" title="Düşük değer daha iyi"><span aria-hidden="true">↓</span><span className="sr-only">Düşük iyi</span></span>}{leader === 'tie' && <span className="category-hint"><span aria-hidden="true">=</span><span className="sr-only">Eşit</span></span>}</th><td className={leader === 'away' ? 'category-leading' : ''}>{categoryValue(a, c.statId)}{leader === 'away' && <span className="category-marker"><span aria-hidden="true">▲</span><span className="sr-only">Önde</span></span>}</td></tr>;
    })}</tbody></table>}
    {isCategoryScoring(league.scoring.type) && categories.length === 0 && <p className="muted">Kategori bilgisi mevcut değil.</p>}
  </article>;
}
