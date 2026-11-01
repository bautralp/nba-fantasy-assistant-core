import { useEffect, useMemo, useState } from 'react';
import type { PublicLeague } from './model.ts';
import { analyzeLeague } from '../../seasonAnalysis/analyzeLeague.ts';
import { CATEGORIES } from '../../seasonAnalysis/model.ts';
import { loadPowerRankings } from '../../seasonAnalysis/loadPowerRankings.ts';
import { displayUpdated } from '../../shared/dates.ts';

const number = (n: number) => n.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export function PowerRankingsScreen({ league, teamId, leagueLoading, leagueError }: {
  league: PublicLeague; teamId: number; leagueLoading: boolean; leagueError: boolean;
}) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof loadPowerRankings>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let active = true, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    // StrictMode's discarded effect is cancelled before issuing static reads.
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const data = await loadPowerRankings(import.meta.env.BASE_URL, controller.signal, Date.now());
        if (active && !controller.signal.aborted) setSources(data);
      } catch (e) {
        if (!active || controller.signal.aborted && !timedOut) return;
        console.error('Power Rankings source load failed', e);
        const unavailable = timedOut || e instanceof TypeError || e instanceof Error && /alınamadı|HTTP/.test(e.message);
        setError(unavailable ? 'Sıralamalar şu anda yüklenemedi.' : 'Güncel sıralama verileri henüz hazır değil.');
      } finally { clearTimeout(timer); }
    });
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, []);
  // Derive the whole result from the current league object. A new ESPN snapshot
  // cannot render ranks calculated against a previous roster, even for one frame.
  const result = useMemo(() => sources && !leagueLoading && !leagueError
    ? analyzeLeague({ league, ...sources, lineupPolicy: 'daily-max-games' }) : null,
  [league, sources, leagueLoading, leagueError]);
  const ready = result?.status === 'ready' && CATEGORIES.every(c =>
    result.rankings[c].length === league.teams.length && result.rankings[c].every(r =>
      r.rank !== null && Number.isFinite(r.rank) && r.projectedValue !== null && Number.isFinite(r.projectedValue)));
  const message = leagueError ? 'Sıralamalar şu anda yüklenemedi.' : error ||
    (result && !ready ? 'Güncel sıralama verileri henüz hazır değil.' : '');
  const loading = !message && (!sources || leagueLoading);
  return <section aria-label="9CAT Power Rankings" aria-busy={loading}>
    <p className="muted">Kalan sezon tahmini</p>
    {loading && <p role="status">Sıralamalar hazırlanıyor…</p>}
    {message && <p role="alert">{message}</p>}
    {ready && result && !message && <>
      <p className="muted">Son güncelleme: <time dateTime={result.dataUpdatedAt}>{displayUpdated(result.dataUpdatedAt)}</time></p>
      <nav className="season-power-summary" aria-label="Benim takımımın kategori sıraları">{CATEGORIES.map(c => <a href={`#season-power-${c.replace('%', 'pct')}`} key={c}>{c} <strong>{result.rankings[c].find(r => r.teamId === teamId)?.rank}</strong></a>)}</nav>
      <div className="season-power-grid">{CATEGORIES.map(c => {
        const rows = result.rankings[c], own = rows.find(r => r.teamId === teamId);
        return <article className="season-card season-power-card" id={`season-power-${c.replace('%', 'pct')}`} key={c} aria-label={`${c} güç sıralaması`}>
          <header><h3>{c} {c === 'TO' && <small>↓ düşük daha iyi</small>}</h3><span className="season-badge">Takımım: {own?.rank}</span></header>
          <table><caption className="sr-only">{c} · Kalan sezon tahmini · Tüm lig takımları</caption><thead><tr><th scope="col">Sıra</th><th scope="col">Takım</th><th scope="col">Tahmin</th></tr></thead><tbody>{rows.map(r => <tr className={r.teamId === teamId ? 'is-mine' : ''} key={r.teamId}><td>{r.rank}</td><th scope="row">{r.name}{r.teamId === teamId && <span className="sr-only"> · Benim takımım</span>}</th><td>{number(r.projectedValue!)}{c.includes('%') ? '%' : ''}</td></tr>)}</tbody></table>
        </article>;
      })}</div>
    </>}
  </section>;
}
