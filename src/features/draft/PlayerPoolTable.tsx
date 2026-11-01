import { useMemo, useState } from 'react';
import type { WorkspaceSnapshot } from '../../domain/models/workspace';
import { POSITIONS } from '../../domain/models/roster';
import { projectionValue, type DraftView } from '../../application/draftSelectors';
import { PLAYER_COLUMNS, PlayerTable, compareCells, type PlayerColumn, type PlayerTableRow } from '../../shared/PlayerTable';
export function PlayerPoolTable({ workspace: w, view: v, onPlayer }: { workspace: WorkspaceSnapshot; view: DraftView; onPlayer: (id: string) => void }) {
  const [search, setSearch] = useState(''), [position, setPosition] = useState(''), [draft, setDraft] = useState('all');
  const [sort, setSort] = useState<PlayerColumn>('RANK'), [ascending, setAscending] = useState(true);
  const rows = useMemo(() => v.pool.filter(p => p.name.toLocaleLowerCase('tr').includes(search.toLocaleLowerCase('tr')) && (!position || v.positions.get(p.id)?.some(pos => pos === position)) && (draft === 'all' || (draft === 'available' ? !v.ownership.has(p.id) : draft === 'picked' ? v.ownership.has(p.id) : v.ownership.get(p.id) === w.league.userTeamId))).map((p): PlayerTableRow => {
    const projection = v.projectionById.get(p.id), owner = v.ownership.get(p.id);
    const status = owner ? w.teams.find(t => t.id === owner)?.name ?? 'Seçilmiş' : 'Seçilmemiş';
    const values = Object.fromEntries(PLAYER_COLUMNS.map(c => {
      if (c === 'OYUNCU ADI') return [c, p.name];
      if (c === 'TAKIM') return [c, projection?.presentation?.team ?? null];
      if (c === 'MPG') return [c, projection?.presentation?.mpg ?? null];
      if (c === 'POS') return [c, v.positions.get(p.id)?.join('/') || null];
      if (c === 'RANK') return [c, v.poolRanking.ranks.get(p.id) ?? null];
      if (c === 'TOTAL Z') return [c, v.poolRanking.totalZ.get(p.id) ?? null];
      const value = projectionValue(projection, c);
      return [c, value !== null && c.endsWith('%') ? value * 100 : value];
    })) as PlayerTableRow['values'];
    return { id: p.id, values, picked: !!owner, title: `Draft: ${status}`, name: <><button data-row-activation className="player-link">{p.name}</button>{projection?.presentation?.modelLabel && <small>{projection.presentation.modelLabel}</small>}{owner && <small aria-label={`Draft sahibi: ${status}`}>● {status}</small>}{projection?.status !== 'valid' && <small>{projection ? 'Analiz dışı' : 'Aktif projeksiyon yok'}</small>}</> };
  }).sort((a, b) => compareCells(a.values[sort], b.values[sort], ascending) || compareCells(v.poolRanking.tieKeys.get(a.id), v.poolRanking.tieKeys.get(b.id), true)), [v, w.teams, w.league.userTeamId, search, position, draft, sort, ascending, onPlayer]);
  return <section className="panel pool-panel" aria-labelledby="pool-heading">
    <h2 id="pool-heading" tabIndex={-1}>Oyuncu havuzu</h2>
    <p className="muted">{v.dataset ? `${v.dataset.unit === 'perGame' ? 'Maç başına' : 'Sezon toplamı'} · GP: ${v.dataset.provenance?.gpMeaning === 'expected-remaining' ? 'tahmini kalan maç' : 'maç sayısı'}` : 'Oyuncuları görmek için bir projeksiyon dosyası yükleyin.'}</p>
    {v.dataset?.provenance?.projectionMode === 'extended' && <p className="muted">Genişletilmiş Tahmin · {v.dataset.provenance.modelVersion} · {v.dataset.provenance.horizon === 'full-season' ? 'Tam sezon' : 'Kalan sezon'} · Koşullu, düşük güvenli model; gerçek istatistik değildir. MPG ve GP tahminidir.</p>}
    {v.dataset && <p className="muted pool-rank-info" role="status">{v.poolRanking.notice}</p>}
    <div className="pool-filters">
      <label>Oyuncu ara<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label>Pozisyon<select aria-label="Pozisyon" value={position} onChange={e => setPosition(e.target.value)}><option value="">Tümü</option>{POSITIONS.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Draft filtresi<select aria-label="Draft filtresi" value={draft} onChange={e => setDraft(e.target.value)}><option value="all">Tümü</option><option value="available">Seçilmemiş</option><option value="picked">Seçilmiş</option><option value="mine">Benim takımım</option></select></label>
      <label>Sıralama<select aria-label="Sıralama" value={sort} onChange={e => { setSort(e.target.value as PlayerColumn); if(e.target.value === 'RANK') setAscending(true); }}>{PLAYER_COLUMNS.map(k => <option key={k}>{k}</option>)}</select></label>
      <button aria-label="Sıralama yönünü değiştir" onClick={() => setAscending(a => !a)}>{ascending ? 'Artan ↑' : 'Azalan ↓'}</button>
    </div>
    <PlayerTable onActivateRow={onPlayer} rows={rows} label="Oyuncu istatistik tablosu" sort={sort} ascending={ascending} resetKey={`${search}-${position}-${draft}`} onSort={c => { setSort(c); setAscending(c === sort ? !ascending : true); }} />
    {!rows.length && <p className="notice">{v.dataset ? 'Bu filtrelerde oyuncu bulunamadı.' : 'Henüz oyuncu dosyası yüklenmedi.'}</p>}
  </section>;
}
