import { useMemo } from 'react';
import type { PublicLeague } from './model.ts';
import { eligiblePositions } from './leaguePresentation.ts';
import { useLeagueEvaluator, useSeasonSources } from './useSeasonSources.ts';
import { useSeasonStrategy } from './useSeasonStrategy.ts';
import { rosterContributions, isReady } from '../../seasonAnalysis/teamInsights.ts';
import { displayUpdated } from '../../shared/dates.ts';
import { GOAL_OPTIONS, formatDelta, formatScore, formatValue, goalLabels, impactSentences, rankChangeText, standingText } from './strategyPresentation.ts';
import type { CategoryTarget } from '../../domain/models/categories.ts';

const games = (n: number) => n.toLocaleString('tr-TR', { maximumFractionDigits: 0 });
export function TeamAnalysisScreen({ league, teamId, leagueLoading, leagueError }: { league: PublicLeague; teamId: number; leagueLoading: boolean; leagueError: boolean }) {
  const { sources, error } = useSeasonSources();
  const evaluator = useLeagueEvaluator(league, sources);
  const strategy = useSeasonStrategy(league.leagueId, league.seasonId, teamId);
  const result = useMemo(() => evaluator && sources && !leagueLoading && !leagueError
    ? rosterContributions(evaluator, league.teams, teamId, strategy.goals, sources.projections) : null,
  [evaluator, sources, league, teamId, strategy.goals, leagueLoading, leagueError]);
  const ready = !!result && isReady(result.baseline);
  const message = leagueError ? 'Takım analizi şu anda yüklenemedi.' : error || (sources && evaluator && !leagueLoading && !ready ? 'Güncel takım analizi verileri henüz hazır değil.' : '');
  const loading = !message && !ready;
  const team = league.teams.find(t => t.espnTeamId === teamId)!;
  const roster = new Map((team.roster ?? []).map(p => [p.espnPlayerId, p]));
  const goalsSet = result?.standings.filter(s => s.targetRank !== null) ?? [];
  const players = result?.players.filter(p => p.impact) ?? [];
  const ir = result?.players.filter(p => p.placement === 'ir') ?? [];
  return <section className="season-analysis" aria-label="Takım Analizi" aria-busy={loading}>
    <p className="muted">Kalan sezon tahmini · Hedefler yalnız öneri ağırlığını değiştirir, tahmini değerleri değiştirmez.</p>
    {loading && <p role="status">Takım analizi hazırlanıyor…</p>}
    {message && <p role="alert">{message}</p>}
    {strategy.error && <p role="alert">{strategy.error}</p>}
    {ready && result && !message && <>
      <p className="muted">Son güncelleme: <time dateTime={result.baseline.dataUpdatedAt}>{displayUpdated(result.baseline.dataUpdatedAt)}</time></p>
      <section className="season-card season-analysis-status" aria-labelledby="team-status-heading">
        <header className="season-analysis-heading">
          <h3 id="team-status-heading">Takımımın Durumu</h3>
          <span className="season-badge">{goalsSet.length ? `Hedefler: ${goalsSet.filter(s => s.status === 'met').length}/${goalsSet.length} sağlanıyor` : 'Hedef belirlenmedi'}</span>
        </header>
        {!goalsSet.length && <p className="muted">Kategori hedeflerini seçerek önerilerin ağırlığını belirleyebilirsin. Hedef seçmeden de analiz görünür.</p>}
        <ul className="season-standings-list">{result.standings.map(s => <li key={s.category} className={`season-standing is-${s.status}`}>
          <div className="season-standing-main">
            <strong>{s.category}{s.category === 'TO' && <small> ↓ düşük daha iyi</small>}</strong>
            <span className="season-standing-rank" aria-label={`${s.category} lig sırası`}>{s.rank}<small>/{s.teams}</small></span>
            <span className="season-standing-value">{formatValue(s.category, s.value)}</span>
          </div>
          <label className="season-goal">Hedef
            <select value={s.goal} aria-label={`${s.category} hedefi`} onChange={e => strategy.setGoal(s.category, e.target.value as CategoryTarget)}>
              {GOAL_OPTIONS.map(g => <option key={g} value={g}>{goalLabels[g]}</option>)}
            </select>
          </label>
          {standingText(s) && <p className="season-standing-text">{standingText(s)}</p>}
        </li>)}</ul>
        {goalsSet.length > 0 || result.standings.some(s => s.goal === 'punt') ? <button type="button" onClick={strategy.clear}>Hedefleri temizle</button> : null}
      </section>
      <section className="season-card season-contributions" aria-labelledby="contributions-heading">
        <header className="season-analysis-heading"><h3 id="contributions-heading">Kadro Katkıları</h3></header>
        <p className="muted">Oyuncu kadrodan çıksaydı takımın ne kaybedeceği: boşalan maçları bench oyuncuları doldurur. Strateji katkısı hedeflerine göre ağırlıklıdır.</p>
        <ol className="season-contribution-list">{players.map((p, i) => {
          const player = roster.get(p.espnPlayerId)!, impact = p.impact!, lost = p.projectedGames !== null && p.usableGames !== null ? p.projectedGames - p.usableGames : 0;
          const tag = i < 3 && impact.strategyScore > 0 ? 'Stratejine en çok katkı' : i >= players.length - 3 && players.length > 6 ? 'Hedeflerinde sınırlı katkı' : null;
          return <li key={p.espnPlayerId} className="season-contribution">
            <div className="season-contribution-head">
              <strong>{p.name}</strong><span className="roster-positions">{eligiblePositions(player)}{p.placement === 'bench' ? ' · Bench' : ''}</span>
              <span className="season-contribution-score" aria-label="Strateji katkısı">{formatScore(impact.strategyScore)}</span>
            </div>
            {tag && <span className="season-badge">{tag}</span>}
            {impactSentences(impact, p.shooting, goalsSet.length > 0).map(line => <p key={line}>{line}</p>)}
            {p.usableGames !== null && p.projectedGames !== null && <p className="muted">Lineup'ta kullanılabilen maç: {games(p.usableGames)} / {games(p.projectedGames)}{lost >= 1 ? ` · Kadro dolu günlerde yaklaşık ${games(lost)} maçı oynatılamıyor.` : ''}</p>}
            <details><summary>Kategori etkileri</summary>
              <table className="season-impact-table"><caption className="sr-only">{p.name} kategori etkileri</caption>
                <thead><tr><th scope="col">Kategori</th><th scope="col">Takıma etki</th><th scope="col">Sıra</th></tr></thead>
                <tbody>{impact.categories.map(c => <tr key={c.category} className={c.weight === 0 ? 'is-punt' : ''}><th scope="row">{c.category}{c.weight === 0 ? ' (punt)' : ''}</th><td>{formatDelta(c.category, c.delta)}</td><td>{rankChangeText({ ...c, beforeRank: c.beforeRank, afterRank: c.afterRank })}</td></tr>)}</tbody>
              </table>
              <p className="muted">Sıra sütunu: oyuncu olmadan → oyuncuyla.</p>
            </details>
          </li>;
        })}</ol>
        {ir.length > 0 && <p className="muted">IR: {ir.map(p => p.name).join(', ')} · IR oyuncuları kalan sezon hesabına katılmaz.</p>}
      </section>
    </>}
  </section>;
}
