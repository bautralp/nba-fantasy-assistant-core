import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { PLAYER_COLUMNS, PAGE_SIZE, formatCell, type PlayerColumn, type PlayerTableRow } from './playerTableModel';
export { PLAYER_COLUMNS, PAGE_SIZE, compareCells, formatCell, type PlayerColumn, type PlayerTableRow } from './playerTableModel';
export function PlayerTable({ rows, label, sort, ascending, onSort, resetKey = '', className = '', onActivateRow }: {
  onActivateRow?: (playerId: string) => void;
  rows: PlayerTableRow[]; label: string; sort: PlayerColumn; ascending: boolean;
  onSort: (column: PlayerColumn) => void; resetKey?: string; className?: string;
}) {
  const id = useId();
  const gesture = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const activate = (event: MouseEvent<HTMLTableRowElement>, row: PlayerTableRow) => {
    if (!onActivateRow) return;
    const control = (event.target as HTMLElement).closest('button, a, input, select, textarea, summary');
    if (control && !control.hasAttribute('data-row-activation')) return;
    const start = gesture.current;
    gesture.current = null;
    if (event.detail !== 0 && start && (start.moved || Math.hypot(event.clientX-start.x,event.clientY-start.y)>8
      || Math.abs((bottom.current?.scrollLeft ?? 0)-start.left)>1 || Math.abs((bottom.current?.scrollTop ?? 0)-start.top)>1)) return;
    (control instanceof HTMLElement ? control : event.currentTarget).focus({ preventScroll: true });
    onActivateRow(row.id);
  };
  const mirrored = useRef(new WeakMap<HTMLDivElement, number>());
  const top = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null), table = useRef<HTMLTableElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [width, setWidth] = useState(0), [overflow, setOverflow] = useState(false), [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
  useEffect(() => { setPage(0); }, [resetKey]);
  useLayoutEffect(() => {
    const measure = () => {
      if (!bottom.current || !table.current || !bottom.current.clientWidth) return;
      setViewportWidth(bottom.current.clientWidth);
      setWidth(table.current.scrollWidth); setOverflow(table.current.scrollWidth > bottom.current.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (bottom.current) observer.observe(bottom.current);
    if (table.current) observer.observe(table.current);
    return () => observer.disconnect();
  }, []);
  const sync = (source: HTMLDivElement, target: HTMLDivElement | null) => {
    // Native scroll events arrive asynchronously. Consume the mirrored event
    // rather than letting an older programmatic event overwrite a newer gesture.
    const expected = mirrored.current.get(source);
    if (expected !== undefined) {
      mirrored.current.delete(source);
      if (Math.abs(source.scrollLeft - expected) <= 1) return;
    }
    if (target && Math.abs(target.scrollLeft - source.scrollLeft) > 1) {
      target.scrollLeft = source.scrollLeft;
      mirrored.current.set(target, target.scrollLeft);
    }
  };
  const go = (next: number) => { setPage(next); if (bottom.current) bottom.current.scrollTop = 0; };
  return <div className={`player-table-frame ${className}`}>
    <div className="pagination" aria-label={`${label} sayfalama`}>
      <span role="status">{rows.length} oyuncu · Sayfa {current + 1} / {pages}</span>
      <div className="actions"><button disabled={!current} onClick={() => go(current - 1)}>Önceki</button><button disabled={current + 1 >= pages} onClick={() => go(current + 1)}>Sonraki</button></div>
    </div>
    <div ref={top} className="top-scrollbar" style={{ width: viewportWidth + 2 }} hidden={!overflow} tabIndex={overflow ? 0 : -1} role="region" aria-label={`${label} üst yatay kaydırma`} aria-controls={id} onScroll={e => sync(e.currentTarget, bottom.current)}><div style={{ width, height: 1 }} /></div>
    <div id={id} ref={bottom} className="table-scroll pool-scroll" tabIndex={0} role="region" aria-label={label} onScroll={e => sync(e.currentTarget, top.current)}>
      <table ref={table} className="rankings-table player-table"><thead><tr>{PLAYER_COLUMNS.map(c => <th className={c === 'OYUNCU ADI' ? 'player-name' : undefined} key={c} scope="col" aria-sort={sort === c ? ascending ? 'ascending' : 'descending' : 'none'}
        // Pointer clicks on the cell area outside the button sort too; keyboard users keep the button.
        onClick={event => { if (event.target === event.currentTarget) onSort(c); }}><button onClick={() => onSort(c)}>{c}</button></th>)}</tr></thead><tbody>
        {rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(row => <tr key={row.id} title={row.title} className={[row.picked ? 'picked-row' : '', onActivateRow ? 'activatable-row' : ''].filter(Boolean).join(' ')}
          tabIndex={onActivateRow ? 0 : undefined} aria-keyshortcuts={onActivateRow ? 'Enter Space' : undefined}
          onPointerDown={onActivateRow ? e => { gesture.current = { x:e.clientX, y:e.clientY, left:bottom.current?.scrollLeft ?? 0, top:bottom.current?.scrollTop ?? 0, moved:false }; } : undefined}
          onPointerMove={onActivateRow ? e => { const start=gesture.current; if(start && Math.hypot(e.clientX-start.x,e.clientY-start.y)>8) start.moved=true; } : undefined}
          onPointerCancel={onActivateRow ? () => { if(gesture.current) gesture.current.moved=true; } : undefined}
          onClick={onActivateRow ? e => activate(e,row) : undefined}
          onKeyDown={onActivateRow ? e => { if(e.target===e.currentTarget && (e.key==='Enter' || e.key===' ')) { e.preventDefault(); if(!e.repeat) onActivateRow(row.id); } } : undefined}>{PLAYER_COLUMNS.map(c => <td key={c} className={c === 'OYUNCU ADI' ? 'player-name player-name-cell' : undefined}>{c === 'OYUNCU ADI' && row.name ? row.name : formatCell(row.values[c], c)}</td>)}</tr>)}
      </tbody></table>
    </div>
    <p className="page-range muted">{rows.length ? current * PAGE_SIZE + 1 : 0}–{Math.min((current + 1) * PAGE_SIZE, rows.length)} / {rows.length} oyuncu · Sayfa başına 50</p>
  </div>;
}
