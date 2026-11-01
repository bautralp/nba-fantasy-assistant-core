import { useMemo, useState } from 'react';
import type { LeagueTeam, PublicLeague } from './model.ts';
import { eligiblePositions } from './leaguePresentation.ts';
import { useLeagueEvaluator, useSeasonSources } from './useSeasonSources.ts';
import { useSeasonStrategy } from './useSeasonStrategy.ts';
import { useTradeScenario } from './useTradeScenario.ts';
import { isReady } from '../../seasonAnalysis/teamInsights.ts';
import { applyScenario, moveScenario, resetScenario, revalidate, simulateTrades, undoScenario, type TradeEvaluation, type TradeTarget } from '../../seasonAnalysis/trade.ts';
import { capacityIssues } from '../../seasonAnalysis/rosterMoves.ts';
import { formatDelta, formatScore, formatValue } from './strategyPresentation.ts';
import { addDropSummary } from './waiverPresentation.ts';
import { tradeTeamSummary } from './tradePresentation.ts';

export function TradeScreen({ league, teamId, leagueLoading, leagueError }: { league: PublicLeague; teamId: number; leagueLoading: boolean; leagueError: boolean }) {
  const { sources, error } = useSeasonSources();
  const evaluator = useLeagueEvaluator(league, sources);
  const strategy = useSeasonStrategy(league.leagueId, league.seasonId, teamId);
  const { scenario: stored, save } = useTradeScenario(league.leagueId, league.seasonId, teamId);
  const others = league.teams.filter(t => t.espnTeamId !== teamId);
  const [partners, setPartners] = useState<number[]>(() => others.length ? [others[0].espnTeamId] : []);
  const [confirmed, setConfirmed] = useState<string | null>(null), [editError, setEditError] = useState('');
  const usable = !!evaluator && !leagueLoading && !leagueError;
  const baseline = useMemo(() => usable ? evaluator!.evaluate(league.teams) : null, [usable, evaluator, league]);
  // Every snapshot change re-checks the stored moves; dropped moves are reported.
  const { scenario, removed } = useMemo(() => revalidate(stored, league.teams), [stored, league]);
  const revision = `${evaluator?.baseRevision ?? ''}:${league.fetchedAt}:${JSON.stringify(scenario.moves)}`;
  const result = useMemo<TradeEvaluation | null>(() => confirmed === revision && baseline && evaluator ? simulateTrades({ evaluator, teams: league.teams, baseline, slots: league.rosterSlots, scenario, myTeamId: teamId, goals: strategy.goals }) : null, [confirmed, revision, baseline, evaluator, league, scenario, teamId, strategy.goals]);
  const preview = useMemo(() => scenario.moves.length ? applyScenario(league.teams, scenario) : null, [league, scenario]);
  const warnings = preview ? preview.teams.flatMap(t => capacityIssues(t, league.rosterSlots)) : [];
  const message = leagueError ? 'Takas Asistanı şu anda yüklenemedi.' : error || (baseline && !isReady(baseline) ? 'Güncel lig analizi verileri henüz hazır değil.' : '');
  const loading = !message && !baseline;
  const teamName = (id: TradeTarget) => id === 'waiver' ? 'Waiver' : league.teams.find(t => t.espnTeamId === id)?.name ?? `Takım ${id}`;
  const playerName = (id: number) => league.teams.flatMap(t => t.roster ?? []).find(p => p.espnPlayerId === id)?.name ?? `ESPN ${id}`;
  const shown = [teamId, ...partners].map(id => league.teams.find(t => t.espnTeamId === id)).filter((t): t is LeagueTeam => !!t);
  const edit = (playerId: number, sourceTeamId: number, value: string) => {
    const target: TradeTarget = value === 'waiver' ? 'waiver' : Number(value);
    const r = moveScenario(scenario, league.teams, { playerId, sourceTeamId, target });
    if ('error' in r) { setEditError(r.error); return; }
    setEditError(''); setConfirmed(null); save(r.scenario);
  };
  const targetOf = (id: number) => scenario.moves.find(m => m.playerId === id)?.target;
  return <section className="season-analysis" aria-label="Takas Asistanı" aria-busy={loading}>
    <p className="muted">Takaslar yalnız simülasyondur; ESPN'e takas gönderilmez. Sonuç, takasın ESPN kurallarına göre geçerli olduğu anlamına gelmez.</p>
    {loading && <p role="status">Takas analizi hazırlanıyor…</p>}
    {message && <p role="alert">{message}</p>}
    {removed.length > 0 && <p role="alert">ESPN kadroları değişti; geçersiz kalan {removed.length} hamle senaryodan çıkarıldı.</p>}
    {baseline && !message && <>
      <div className="season-trade-teams">
        {partners.map((id, i) => <label key={i}>{i === 0 ? 'Takas yapılacak takım' : `${i + 1}. takım`}
          <select value={id} onChange={e => { const v = Number(e.target.value); setPartners(p => p.map((x, j) => j === i ? v : x)); }}>{others.filter(t => t.espnTeamId === id || !partners.includes(t.espnTeamId)).map(t => <option key={t.espnTeamId} value={t.espnTeamId}>{t.name}</option>)}</select>
        </label>)}
        {partners.length < others.length && <button type="button" onClick={() => setPartners(p => [...p, others.find(t => !p.includes(t.espnTeamId))!.espnTeamId])}>Takım ekle</button>}
        {partners.length > 1 && <button type="button" onClick={() => setPartners(p => p.slice(0, -1))}>Son takımı çıkar</button>}
      </div>
      <div className="season-trade-grid">{shown.map(team => {
        const incoming = scenario.moves.filter(m => m.target === team.espnTeamId);
        return <article key={team.espnTeamId} className={`season-card season-trade-team${team.espnTeamId === teamId ? ' is-mine' : ''}`}>
          <header className="season-roster-heading"><h4>{team.name}</h4>{team.espnTeamId === teamId && <span className="season-badge">Benim takımım</span>}</header>
          <ul className="season-trade-roster">{(team.roster ?? []).map(p => {
            const target = targetOf(p.espnPlayerId);
            return <li key={p.espnPlayerId} className={target !== undefined ? 'is-moving' : ''}>
              <span><strong>{p.name}</strong> <span className="roster-positions">{eligiblePositions(p)}{p.placement === 'ir' ? ' · IR' : ''}</span></span>
              <select aria-label={`${p.name} hedefi`} value={target === undefined ? String(team.espnTeamId) : String(target)} onChange={e => edit(p.espnPlayerId, team.espnTeamId, e.target.value)}>
                <option value={team.espnTeamId}>Kalır</option>
                {league.teams.filter(t => t.espnTeamId !== team.espnTeamId).map(t => <option key={t.espnTeamId} value={t.espnTeamId}>→ {t.name}</option>)}
                <option value="waiver">→ Waiver</option>
              </select>
            </li>;
          })}</ul>
          {incoming.length > 0 && <p className="season-trade-incoming">Gelen: {incoming.map(m => `${playerName(m.playerId)} (${teamName(m.sourceTeamId)})`).join(', ')}</p>}
        </article>;
      })}</div>
      {editError && <p role="alert">{editError}</p>}
      <section className="season-card season-trade-moves" aria-label="Senaryo hamleleri">
        <h3>Senaryo</h3>
        {scenario.moves.length ? <ol>{scenario.moves.map(m => <li key={m.playerId}>{playerName(m.playerId)}: {teamName(m.sourceTeamId)} → {teamName(m.target)}</li>)}</ol> : <p className="muted">Henüz hamle yok. Bir oyuncunun yanındaki listeden yeni takımını seç.</p>}
        {warnings.map(w => <p role="alert" key={w}>{w}</p>)}
        <div className="season-actions">
          <button type="button" className="primary" disabled={!scenario.moves.length || warnings.length > 0} onClick={() => setConfirmed(revision)}>Takasın etkisini gör</button>
          <button type="button" disabled={!scenario.history.length} onClick={() => { setConfirmed(null); save(undoScenario(scenario)); }}>Son hamleyi geri al</button>
          <button type="button" disabled={!scenario.moves.length} onClick={() => { setConfirmed(null); save(resetScenario(scenario)); }}>Senaryoyu sıfırla</button>
        </div>
      </section>
      {result && <TradeResult result={result} teamId={teamId} />}
    </>}
  </section>;
}

function TradeResult({ result, teamId }: { result: TradeEvaluation; teamId: number }) {
  if (result.blockers.length) return <section className="season-card" aria-label="Takas sonucu">{result.blockers.map(b => <p role="alert" key={b}>{b}</p>)}{result.notes.map(n => <p className="muted" key={n}>{n}</p>)}</section>;
  const involved = result.impacts.filter(i => result.involved.includes(i.teamId)).sort((a, b) => Number(b.teamId === teamId) - Number(a.teamId === teamId));
  const bystanders = result.impacts.filter(i => !result.involved.includes(i.teamId) && i.categories.some(c => c.rankGain !== 0));
  const name = (id: number) => result.before.teams.find(t => t.teamId === id)!.name;
  return <section className="season-trade-result" aria-label="Takas sonucu">
    <h3>Takasın etkisi</h3>
    {result.notes.map(n => <p className="muted" key={n}>{n}</p>)}
    <div className="season-trade-grid">{involved.map(impact => <article key={impact.teamId} className={`season-card${impact.teamId === teamId ? ' is-mine' : ''}`} aria-label={`${name(impact.teamId)} takas etkisi`}>
      <header className="season-roster-heading"><h4>{name(impact.teamId)}</h4>{impact.teamId === teamId && <span className="season-badge">Benim takımım</span>}</header>
      {tradeTeamSummary(impact, impact.teamId === teamId).map(l => <p key={l}>{l}</p>)}
      {addDropSummary(impact, impact.teamId === teamId).map(l => <p key={l}><strong>{l}</strong></p>)}
      <table className="season-impact-table"><caption className="sr-only">{name(impact.teamId)} önce/sonra</caption>
        <thead><tr><th scope="col">Kategori</th><th scope="col">Önce</th><th scope="col">Sonra</th><th scope="col">Fark</th><th scope="col">Sıra</th></tr></thead>
        <tbody>{impact.categories.map(c => <tr key={c.category} className={c.weight === 0 ? 'is-punt' : ''}><th scope="row">{c.category}{c.weight === 0 ? ' (punt)' : ''}</th><td>{formatValue(c.category, c.before)}</td><td>{formatValue(c.category, c.after)}</td><td>{formatDelta(c.category, c.delta)}</td><td className={c.rankGain > 0 ? 'is-up' : c.rankGain < 0 ? 'is-down' : ''}>{c.beforeRank}. → {c.afterRank}.</td></tr>)}</tbody>
      </table>
      {impact.teamId === teamId && <p className="muted">Strateji puanı: {formatScore(impact.strategyScore)}</p>}
    </article>)}</div>
    {bystanders.length > 0 && <details className="season-card"><summary>Takasa katılmayan takımlarda sıra değişimi ({bystanders.length})</summary>
      <ul>{bystanders.map(i => <li key={i.teamId}><strong>{name(i.teamId)}</strong>: {i.categories.filter(c => c.rankGain !== 0).map(c => `${c.category} ${c.beforeRank}.→${c.afterRank}.`).join(', ')}</li>)}</ul>
    </details>}
    <p className="muted">Kontrol edilmeyen ESPN kuralları: takas son tarihi, veto/onay süreci, oyuncu kilitleri, waiver bekleme süreleri ve lige özel diğer kurallar.</p>
  </section>;
}
