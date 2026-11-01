import { datasetUrl } from '../../publicCore/dataAccess.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadScenarios } from '../../projections/loadScenarios';
import { parseProjections, type ROSSnapshot } from './rosProjection';
import { PlayerTable, compareCells, type PlayerColumn, type PlayerTableRow } from '../../shared/PlayerTable';
import { displayDay, displayUpdated } from '../../shared/dates';
import { applyWeights, DEFAULT_WEIGHTS, isDefaultWeights, rosZScores, type CategoryWeights } from './categoryWeights';
export function ProjectedRankings({ lastGameDate, weights = DEFAULT_WEIGHTS }: { lastGameDate?: string | null; weights?: CategoryWeights }) {
  const [refreshStatus, setRefreshStatus] = useState('');
  const [snapshot, setSnapshot] = useState<ROSSnapshot | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [search, setSearch] = useState('');
  const [sort, setSort] = useState<PlayerColumn>('TOTAL Z'), [asc, setAsc] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    setLoading(true); setError('');
    try {
      const response = await fetch(datasetUrl(import.meta.env.BASE_URL,'player-projections.json'), { signal: controller.signal, cache: 'no-cache' });
      if (!response.ok) throw new Error();
      const standard = parseProjections(await response.json());
      const next = (await loadScenarios(import.meta.env.BASE_URL, controller.signal, standard)).projection;
      if (request.current === controller) setSnapshot(old => old && old.generatedAt > next.generatedAt ? old : next);
    } catch { if (request.current === controller) setError('Projeksiyon yenilenemedi. Varsa son geçerli projeksiyonlar korunuyor.'); }
    finally { clearTimeout(timer); if (request.current === controller) setLoading(false); }
  };
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void refresh(); });
    return () => { mounted = false; request.current?.abort(); request.current = null; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    // Same StrictMode guard as refresh(): the probe's cleanup aborts before this microtask, so no request is dispatched and cancelled.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void fetch(datasetUrl(import.meta.env.BASE_URL,'projection-refresh-status.json'), { signal: controller.signal, cache: 'no-cache' })
        .then(async r => { if (!r.ok) throw new Error(); return r.json() as Promise<unknown>; })
        .then(v => {
          if (v && typeof v === 'object' && 'status' in v && v.status === 'degraded') setRefreshStatus('Son yenilemenin bazı kaynakları güncellenemedi; son geçerli veriler kullanılıyor.');
        }).catch(() => { /* Successful projection carries its own generation date. */ }).finally(() => clearTimeout(timer));
    });
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  // Default weights show the published ranking unchanged; other weights re-rank the same z-scores.
  const weighted = useMemo(() => snapshot && !isDefaultWeights(weights) ? new Map(applyWeights(rosZScores(snapshot), weights).map(p => [p.id, p])) : null, [snapshot, weights]);
  const rows = useMemo(() => (snapshot?.players ?? []).filter(p => p.status === 'available' && p.stats && p.name.toLocaleLowerCase('tr-TR').includes(search.toLocaleLowerCase('tr-TR'))).map((p): PlayerTableRow => ({ id: p.id,
    title: [...p.uncertainty, p.injuryStatus ?? ''].filter(Boolean).join(' · '),
    values: { RANK: weighted ? weighted.get(p.id)?.rank ?? null : p.rank, 'OYUNCU ADI': p.name, TAKIM: p.team === 'Unknown' ? null : p.team, POS: p.positions.join('/') || null, GP: p.rosGP, MPG: p.minutes, ...p.stats!, 'TOTAL Z': weighted ? weighted.get(p.id)?.totalZ ?? null : p.totalZ },
  })).sort((a, b) => compareCells(a.values[sort], b.values[sort], asc) || a.id.localeCompare(b.id)), [snapshot, weighted, search, sort, asc]);
  return <section aria-label="ROS projeksiyonları" aria-busy={loading}>
    {loading && <p role="status">Projeksiyonlar yükleniyor…</p>}{error && <p role="alert">{error}<button disabled={loading} onClick={() => void refresh()}>Projeksiyonu yeniden dene</button></p>}
    {refreshStatus && <p role="status">{refreshStatus}</p>}
    {snapshot && <>
      <p className="stats-dates">Son güncelleme: <time dateTime={snapshot.generatedAt}>{displayUpdated(snapshot.generatedAt)}</time><span>Son maç tarihi: {displayDay(lastGameDate)}</span></p>
      {Date.now() - Date.parse(snapshot.generatedAt) > 36 * 3600000 && <p role="status">Projeksiyon güncellemesi gecikmiş olabilir; son geçerli sürüm gösteriliyor.</p>}
      <label className="player-search">Oyuncu adıyla ara<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <PlayerTable rows={rows} label="Projected oyuncu sıralamaları" sort={sort} ascending={asc} resetKey={search} onSort={c => { setSort(c); setAsc(sort === c ? !asc : c !== 'TOTAL Z'); }} />
      <details className="table-help"><summary>Projeksiyon bilgisi</summary><p>GP: tahmini kalan maç · MPG: tahmini maç başı dakika</p><p>TOTAL Z: saf 9CAT maç başına üretim. GP ile çarpılmaz. Yalnız geçerli sayısal projeksiyonlar gösterilir; belirsiz kalan maç sayısı — olarak gösterilir.</p>{!error && <button disabled={loading} onClick={() => void refresh()}>Projeksiyonu yeniden dene</button>}</details>
    </>}
  </section>;
}
