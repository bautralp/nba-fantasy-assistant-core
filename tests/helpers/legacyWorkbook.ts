/** Legacy files remain readable. These fixtures intentionally contain PLAYER_ID;
 * the production manual template uses the new header list without it. */
import { createWorkbook as workbook } from '../../src/infrastructure/projections/workbook.ts';
import { HEADERS } from '../../src/application/projectionRows.ts';
export function createWorkbook(season: string, unit: 'perGame' | 'totals', rows: readonly (readonly unknown[])[] = []) {
  return rows.length ? workbook(season, unit, rows, HEADERS) : workbook(season, unit);
}
