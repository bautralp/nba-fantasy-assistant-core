import { datasetUrl } from '../../publicCore/dataAccess.ts';
import { PlayerTable, compareCells, type PlayerColumn, type PlayerTableRow } from '../../shared/PlayerTable';
import { displayDay, displayUpdated } from '../../shared/dates';
import { parseRosters, zeroGamePlayers, type CurrentRosters } from './currentRosters';
import { parseFantasyCatalog, type FantasyEligibility } from './rosProjection';
import { ProjectedRankings } from './ProjectedRankings';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseSnapshot, periods } from './centralStats';
import { playerZScores } from './playerZScores';
import type { Period, StatsSnapshot } from './centralStats';
import { applyWeights, isDefaultWeights, loadWeights, saveWeights, type CategoryWeights } from './categoryWeights';
import { CategoryWeightsPanel, weightsSummary } from './CategoryWeightsPanel';
export function CentralRankings() {
  const [eligibility, setEligibility] = useState<FantasyEligibility[]>([]);
  const [roster, setRoster] = useState<CurrentRosters | null>(null);
  const [positionError, setPositionError] = useState('');
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [period, setPeriod] = useState<Period | 'projected'>('season');
  const [projectedOpened, setProjectedOpened] = useState(false);
  const [search, setSearch] = useState(''), [sort, setSort] = useState<PlayerColumn>('TOTAL Z'), [asc, setAsc] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [weights, setWeights] = useState<CategoryWeights>(() => loadWeights()), [weightsNotice, setWeightsNotice] = useState('');
  const changeWeights = (next: CategoryWeights) => { setWeights(next); setWeightsNotice(saveWeights(next) ? '' : 'Katsayılar bu oturuma kaydedilemedi; sayfa yenilenene kadar geçerli.'); };
  const request = useRef<AbortController | null>(null);
  const refresh = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    setLoading(true); setError('');
    try {
      const response = await fetch(datasetUrl(import.meta.env.BASE_URL,'player-stats.json'), { signal: controller.signal, cache: 'no-cache' });
      if (!response.ok) throw new Error('İstatistik dosyası alınamadı.');
      const next = parseSnapshot(await response.json());
      if (request.current === controller) setSnapshot(previous => {
        if (previous && Date.parse(next.refreshedAt) < Date.parse(previous.refreshedAt)) return previous;
        return next;
      });
    } catch {
      if (request.current === controller) setError('Veri yenilenemedi. Varsa son geçerli istatistikler gösteriliyor. Tekrar deneyebilirsin.');
    } finally {
      clearTimeout(timer);
      if (request.current === controller) setLoading(false);
    }
  };
  useEffect(() => {
    // StrictMode's setup/cleanup probe must not dispatch and immediately cancel
    // the same static JSON request before the real mount starts its request.
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
      void fetch(datasetUrl(import.meta.env.BASE_URL,'fantasy-positions.json'), { signal: controller.signal, cache: 'no-cache' })
        .then(async response => { if (!response.ok) throw new Error(); return parseFantasyCatalog(await response.json()); })
        .then(rows => { if (!controller.signal.aborted) setEligibility(rows); })
        .catch(() => { if (!controller.signal.aborted) setPositionError('Fantasy pozisyon kataloğu alınamadı.'); })
        .finally(() => clearTimeout(timer));
    });
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    // Same StrictMode guard as refresh(): the probe's cleanup aborts before this microtask, so no request is dispatched and cancelled.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void fetch(datasetUrl(import.meta.env.BASE_URL,'current-rosters.json'), { signal: controller.signal, cache: 'no-cache' })
        .then(async r => { if (!r.ok) throw new Error(); return parseRosters(await r.json()); })
        .then(v => { if (!controller.signal.aborted) setRoster(v); }).catch(() => {}).finally(() => clearTimeout(timer));
    });
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const positionMap = useMemo(() => new Map(eligibility.filter(p => p.status === 'verified').map(p => [p.playerId, p.positions.join('/')])), [eligibility]);
  const data = period === 'projected' ? undefined : snapshot?.periods[period];
  const rows = useMemo(() => {
    const played = applyWeights(playerZScores(data?.players ?? []).players, weights);
    const zero = period === 'lastSeason' ? [] : zeroGamePlayers(data?.players ?? [], roster).map(p => ({ ...p, rank: null, totalZ: null }));
    return [...played, ...zero].filter(p => p.name.toLocaleLowerCase('tr-TR').includes(search.toLocaleLowerCase('tr-TR'))).map((p): PlayerTableRow => ({ id: p.id,
      title: p.gp === 0 ? 'Güncel ESPN roster kaydı · Bu dönemde oynanan maç yok; analiz dışı.' : undefined,
      values: { RANK: p.rank, 'OYUNCU ADI': p.name, TAKIM: p.team, POS: eligibility.find(e => e.playerId === p.id)?.name?.toLocaleLowerCase() === p.name.toLocaleLowerCase() ? positionMap.get(p.id) || null : null, GP: p.gp, MPG: p.mpg ?? null, ...p.stats, 'TOTAL Z': p.totalZ },
    })).sort((a, b) => compareCells(a.values[sort], b.values[sort], asc) || a.id.localeCompare(b.id));
  }, [data, roster, eligibility, positionMap, period, search, sort, asc, weights]);
  const stale = snapshot && Date.now() - Date.parse(snapshot.refreshedAt) > 36 * 60 * 60 * 1000;
  return <section className="panel central-panel" aria-busy={loading}>
    <h2 id="central-rankings-heading" tabIndex={-1}>Oyuncu Sıralamaları</h2>
    <div className="stats-toolbar"><div className="period-field"><label htmlFor="stats-period">Dönem</label><select id="stats-period" value={period} onChange={e => { setPeriod(e.target.value as Period | 'projected'); if (e.target.value === 'projected') setProjectedOpened(true); }}>{Object.entries(periods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="projected">2026-27 Kalan Sezon Tahmini</option></select></div>
    {period !== 'projected' && snapshot && <div className="stats-dates"><span>Son güncelleme: <time dateTime={snapshot.refreshedAt}>{displayUpdated(snapshot.refreshedAt)}</time></span><span>Son maç tarihi: {displayDay(data?.dataThrough)}</span></div>}</div>
    <CategoryWeightsPanel weights={weights} onChange={changeWeights} notice={weightsNotice} />
    {!isDefaultWeights(weights) && <p className="weighted-note" role="status">Ağırlıklı sıralama: {weightsSummary(weights)}. RANK ve TOTAL Z bu katsayılarla hesaplanıyor.</p>}
    <div hidden={period !== 'projected'}>{projectedOpened && <ProjectedRankings lastGameDate={snapshot?.periods.season.dataThrough} weights={weights} />}</div>
    <div hidden={period === 'projected'}>
      {positionError && <p role="status">{positionError}</p>}
      {loading && <p role="status">İstatistikler yükleniyor…</p>}
      {error && <p role="alert">{error} <button disabled={loading} onClick={() => void refresh()}>Veriyi yeniden dene</button></p>}
      {stale && <p role="status">Güncelleme gecikmiş olabilir. Son geçerli veriler gösteriliyor.</p>}
      {snapshot && data && <>
        <label className="player-search">Oyuncu adıyla ara<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
        {!rows.length && <p role="status">{data.players.length ? 'Aramanla eşleşen oyuncu bulunamadı.' : 'Bu takvim döneminde kaynağa kaydedilmiş maç bulunmuyor.'}</p>}
        <PlayerTable rows={rows} label="SportsDataverse oyuncu istatistikleri" sort={sort} ascending={asc} resetKey={`${period}-${search}`} onSort={c => { setSort(c); setAsc(sort === c ? !asc : c !== 'TOTAL Z'); }} />
        <details className="table-help"><summary>İstatistik bilgisi</summary><p>GP: gerçekleşen maç sayısı. MPG: toplam dakika / GP. SportsDataverse normal sezon verileri; her dönem ayrı 9CAT dağılımı kullanır. ESPN roster kaydıyla eklenen 0 GP oyuncular sıralama ve analiz dışıdır; roster kaydı maç uygunluğu garantisi değildir. Güncel roster kanıtı alınamadığında veya 36 saati geçtiğinde ek satırlar gösterilmez.</p>{!error && <button disabled={loading} onClick={() => void refresh()}>Veriyi yeniden dene</button>}</details>
      </>}
    </div>
  </section>;
}
