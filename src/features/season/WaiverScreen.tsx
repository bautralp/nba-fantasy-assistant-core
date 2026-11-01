import { useMemo, useState } from 'react';
import type { PublicLeague } from './model.ts';
import { useLeagueEvaluator, useSeasonSources } from './useSeasonSources.ts';
import { useSeasonStrategy } from './useSeasonStrategy.ts';
import { useWaiverPool } from './useWaiverPool.ts';
import { StrategyEditor } from './StrategyEditor.tsx';
import { rosterContributions, isReady } from '../../seasonAnalysis/teamInsights.ts';
import { bestDrop, candidateIssue, simulateAddDrop, type AddDropAnalysis } from '../../seasonAnalysis/addDrop.ts';
import { rosterCapacity } from '../../seasonAnalysis/rosterMoves.ts';
import { CATEGORIES } from '../../seasonAnalysis/model.ts';
import type { WaiverPlayer } from '../../infrastructure/espn/waiverPool.ts';
import { BASKETBALL_POSITIONS } from './positions.ts';
import { displayUpdated } from '../../shared/dates.ts';
import { formatDelta, formatScore, formatValue, impactSentences } from './strategyPresentation.ts';
import { addDropSummary } from './waiverPresentation.ts';

const PAGE = 20;
const one = (n: number) => n.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export function WaiverScreen({ league, teamId, leagueLoading, leagueError }: { league: PublicLeague; teamId: number; leagueLoading: boolean; leagueError: boolean }) {
  const { sources, error } = useSeasonSources();
  const evaluator = useLeagueEvaluator(league, sources);
  const strategy = useSeasonStrategy(league.leagueId, league.seasonId, teamId);
  const pool = useWaiverPool(league);
  const [query, setQuery] = useState(''), [position, setPosition] = useState(''), [status, setStatus] = useState(''), [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<{ addId: number; dropId: number | null; revision: string } | null>(null);
  const usable = !!evaluator && !!sources && !leagueLoading && !leagueError;
  const team = useMemo(() => usable ? rosterContributions(evaluator!, league.teams, teamId, strategy.goals, sources!.projections) : null, [usable, evaluator, league, teamId, strategy.goals, sources]);
  const projection = useMemo(() => new Map(sources?.projections.map(p => [p.espnId, p]) ?? []), [sources]);
  const active = rosterCapacity(league.rosterSlots).active;
  // Default comparison drop: the roster player with the lowest strategy contribution.
  const defaultDrop = team?.players.filter(p => p.impact).at(-1) ?? null;
  const ranked = useMemo(() => {
    if (!team || !pool.pool || !evaluator || !defaultDrop || !isReady(team.baseline)) return null;
    const owned = new Set(league.teams.flatMap(t => t.roster ?? []).map(p => p.espnPlayerId));
    return pool.pool.players.filter(p => !owned.has(p.espnPlayerId)).map(p => {
      const issue = candidateIssue(p, projection.get(p.espnPlayerId), active);
      const sim = issue ? null : simulateAddDrop({ evaluator, teams: league.teams, baseline: team.baseline, slots: league.rosterSlots, myTeamId: teamId, add: p, dropId: defaultDrop.espnPlayerId, goals: strategy.goals, projection: projection.get(p.espnPlayerId) });
      return { player: p, issue: issue ?? sim?.blockers[0] ?? null, sim: sim?.impact ? sim : null };
    }).sort((a, b) => (b.sim?.impact!.strategyScore ?? -Infinity) - (a.sim?.impact!.strategyScore ?? -Infinity) || a.player.espnPlayerId - b.player.espnPlayerId);
  }, [team, pool.pool, evaluator, defaultDrop, league, projection, active.join(','), teamId, strategy.goals]);
  const filtered = ranked?.filter(r => (!query || r.player.name.toLocaleLowerCase('tr-TR').includes(query.toLocaleLowerCase('tr-TR')))
    && (!position || r.player.displayPositions.includes(position as never)) && (!status || r.player.status === status)) ?? [];
  const hiddenOwned = pool.pool && ranked ? pool.pool.players.length - ranked.length : 0;
  const message = leagueError ? 'Waiver Asistanı şu anda yüklenemedi.' : error || pool.error || (team && !isReady(team.baseline) ? 'Güncel takım analizi verileri henüz hazır değil.' : '');
  const loading = !message && !ranked;
  // A selection is valid only for the analysis snapshot it was made on.
  const current = selected && evaluator && selected.revision === evaluator.baseRevision + league.fetchedAt ? selected : null;
  const scenario = useMemo<AddDropAnalysis | null>(() => {
    if (!current || !team || !evaluator) return null;
    const add = pool.pool?.players.find(p => p.espnPlayerId === current.addId);
    if (!add) return null;
    const args = { evaluator, teams: league.teams, baseline: team.baseline, slots: league.rosterSlots, myTeamId: teamId, add, goals: strategy.goals, projection: projection.get(add.espnPlayerId) };
    if (current.dropId !== null) return simulateAddDrop({ ...args, dropId: current.dropId });
    return bestDrop(args, team.players.filter(p => p.placement !== 'ir').map(p => p.espnPlayerId)) ?? simulateAddDrop({ ...args, dropId: defaultDrop?.espnPlayerId ?? -1 });
  }, [current, team, evaluator, pool.pool, league, teamId, strategy.goals, projection, defaultDrop]);
  const roster = league.teams.find(t => t.espnTeamId === teamId)?.roster ?? [];
  const addPlayer = scenario ? pool.pool?.players.find(p => p.espnPlayerId === scenario.addId) : undefined;
  return <section className="season-analysis" aria-label="Waiver Asistanı" aria-busy={loading}>
    <p className="muted">Ekle/bırak yalnız simülasyondur; ESPN'de işlem yapılmaz. Gerçek işlemi ESPN'de sen yaparsın.</p>
    <StrategyEditor goals={strategy.goals} onChange={strategy.setGoal} onClear={strategy.clear} />
    {loading && <p role="status">Oyuncu havuzu ve takım analizi hazırlanıyor…</p>}
    {message && <p role="alert">{message}</p>}
    {strategy.error && <p role="alert">{strategy.error}</p>}
    {scenario && addPlayer && <AddDropPanel scenario={scenario} add={addPlayer} roster={roster} onDrop={dropId => setSelected(s => s && { ...s, dropId })} onClose={() => setSelected(null)} />}
    {ranked && pool.pool && !message && <>
      <p className="muted">ESPN havuzu: {pool.pool.players.length - hiddenOwned} oyuncu · <time dateTime={pool.pool.fetchedAt}>{displayUpdated(pool.pool.fetchedAt)}</time>
        {pool.pool.completeness === 'truncated' ? ` · Sahiplik oranına göre ilk ${pool.pool.pagesRead * pool.pool.pageSize} kayıt okundu; havuzun tamamı değil${pool.pool.total !== null ? ` (ESPN toplamı ${pool.pool.total})` : ''}.` : ''}
        {hiddenOwned > 0 ? ` · Lig kadrosunda görünen ${hiddenOwned} oyuncu listeden çıkarıldı.` : ''}</p>
      {defaultDrop && <p className="muted">Sıralama: oyuncuyu ekleyip stratejine en az katkı veren <strong>{defaultDrop.name}</strong> oyuncusunu bıraksaydın takımına etkisi. Oyuncuyu seçince en iyi bırakma seçeneği hesaplanır.</p>}
      <div className="season-waiver-filters" role="search">
        <label>Oyuncu ara<input value={query} onChange={e => { setQuery(e.target.value); setShown(PAGE); }} autoComplete="off" /></label>
        <label>Pozisyon<select value={position} onChange={e => { setPosition(e.target.value); setShown(PAGE); }}><option value="">Tümü</option>{BASKETBALL_POSITIONS.map(p => <option key={p}>{p}</option>)}</select></label>
        <label>Durum<select value={status} onChange={e => { setStatus(e.target.value); setShown(PAGE); }}><option value="">Tümü</option><option value="FREEAGENT">Serbest</option><option value="WAIVERS">Waiver</option></select></label>
      </div>
      <p className="sr-only" role="status">{filtered.length} oyuncu listeleniyor</p>
      <ol className="season-waiver-list">{filtered.slice(0, shown).map(({ player: p, issue, sim }) => {
        const row = projection.get(p.espnPlayerId), s = row?.unit === 'perGame' ? row.stats : null;
        return <li key={p.espnPlayerId} className="season-contribution season-waiver-player">
          <div className="season-contribution-head"><strong>{p.name}</strong><span className="roster-positions">{p.displayPositions.join(' · ') || '—'} · {p.status === 'WAIVERS' ? 'Waiver' : 'Serbest'}</span>
            <span className="season-contribution-score" aria-label="Takımına etkisi">{sim ? formatScore(sim.impact!.strategyScore) : '—'}</span></div>
          {s && row && <p className="season-waiver-stats">Maç başı: {one(s.PTS)} PTS · {one(s.REB)} REB · {one(s.AST)} AST · {one(s['3PM'])} 3PM · {one(s.STL)} STL · {one(s.BLK)} BLK · {one(s.TO)} TO · FG {s.FGA > 0 ? `%${one(100 * s.FGM / s.FGA)}` : '—'} · FT {s.FTA > 0 ? `%${one(100 * s.FTM / s.FTA)}` : '—'} · Kalan {one(row.expectedGames ?? 0)} maç</p>}
          {sim ? impactSentences(sim.impact!, s, CATEGORIES.some(c => strategy.goals[c] !== 'unset' && strategy.goals[c] !== 'punt')).map(l => <p key={l}>{l}</p>) : <p className="muted">Hesaplanamıyor: {issue}</p>}
          {sim && <button type="button" onClick={() => setSelected({ addId: p.espnPlayerId, dropId: null, revision: evaluator!.baseRevision + league.fetchedAt })}>Ekle/bırak senaryosu</button>}
        </li>;
      })}</ol>
      {!filtered.length && <p>Bu filtrelerle oyuncu yok.</p>}
      {filtered.length > shown && <button type="button" onClick={() => setShown(n => n + PAGE)}>Daha fazla göster ({filtered.length - shown})</button>}
    </>}
  </section>;
}

function AddDropPanel({ scenario, add, roster, onDrop, onClose }: { scenario: AddDropAnalysis; add: WaiverPlayer; roster: readonly { espnPlayerId: number; name: string; placement: string }[]; onDrop: (id: number) => void; onClose: () => void }) {
  const impact = scenario.impact;
  return <section className="season-card season-adddrop" aria-label="Ekle/bırak simülasyonu">
    <header className="season-analysis-heading"><h3>{add.name} ekle</h3><button type="button" onClick={onClose}>Senaryoyu kapat</button></header>
    <label>Bırakılacak oyuncu
      <select value={scenario.dropId} onChange={e => onDrop(Number(e.target.value))}>{roster.map(p => <option key={p.espnPlayerId} value={p.espnPlayerId}>{p.name}{p.placement === 'ir' ? ' (IR)' : p.placement === 'bench' ? ' (Bench)' : ''}</option>)}</select>
    </label>
    {scenario.blockers.map(b => <p role="alert" key={b}>{b}</p>)}
    {scenario.notes.map(n => <p className="muted" key={n}>{n}</p>)}
    {impact && <>
      {addDropSummary(impact).map(l => <p key={l}><strong>{l}</strong></p>)}
      <table className="season-impact-table season-adddrop-table"><caption className="sr-only">Önce ve sonra kategori değerleri</caption>
        <thead><tr><th scope="col">Kategori</th><th scope="col">Önce</th><th scope="col">Sonra</th><th scope="col">Fark</th><th scope="col">Sıra</th></tr></thead>
        <tbody>{impact.categories.map(c => <tr key={c.category} className={c.weight === 0 ? 'is-punt' : ''}><th scope="row">{c.category}{c.weight === 0 ? ' (punt)' : ''}</th><td>{formatValue(c.category, c.before)}</td><td>{formatValue(c.category, c.after)}</td><td>{formatDelta(c.category, c.delta)}</td>
          <td className={c.rankGain > 0 ? 'is-up' : c.rankGain < 0 ? 'is-down' : ''}>{c.beforeRank}. → {c.afterRank}.</td></tr>)}</tbody>
      </table>
      <p className="muted">Strateji puanı: {formatScore(impact.strategyScore)} · FG% ve FT% takımın toplam isabet / toplam denemesidir.</p>
    </>}
  </section>;
}
