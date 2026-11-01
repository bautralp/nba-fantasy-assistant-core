import type { ReactNode } from 'react';
export const PLAYER_COLUMNS = ['RANK', 'OYUNCU ADI', 'TAKIM', 'POS', 'GP', 'MPG', 'FGA', 'FGM', 'FG%', 'FTA', 'FTM', 'FT%', 'PTS', '3PM', 'AST', 'STL', 'REB', 'BLK', 'TO', 'TOTAL Z'] as const;
export type PlayerColumn = typeof PLAYER_COLUMNS[number];
export type CellValue = number | string | null | undefined;
export interface PlayerTableRow { id: string; values: Record<PlayerColumn, CellValue>; name?: ReactNode; title?: string; picked?: boolean }
export const PAGE_SIZE = 50;
export function compareCells(a: CellValue, b: CellValue, ascending: boolean) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'tr')) * (ascending ? 1 : -1);
}
export function formatCell(value: CellValue, column: PlayerColumn) {
  if (value == null || value === '') return '—';
  if (typeof value !== 'number') return value;
  if (column === 'RANK' || column === 'GP') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${value.toFixed(column === 'TOTAL Z' ? 2 : 1)}${column.endsWith('%') ? '%' : ''}`;
}
