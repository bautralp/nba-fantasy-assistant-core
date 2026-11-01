import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import { normalizeFile, canonical, ImportError, type RawFile } from './projectionRows.ts';
import { prepareImport, applyImport, type ImportPreview } from './importPlayers.ts';

/** Old file IDs are deliberately ignored; only independent workspace UUIDs identify players. */
export function normalizeManualFile(raw: RawFile, metadata: { season?: string; unit?: string } = {}) {
  const columns = raw.headers.map((h, i) => canonical(h) === 'PLAYER_ID' ? -1 : i).filter(i => i >= 0);
  const file = normalizeFile({ ...raw, headers: columns.map(i => raw.headers[i]), rows: raw.rows.map(r => columns.map(i => r[i])) }, metadata);
  const names = new Map<string, number>();
  for (const row of file.rows) {
    const name = row.name.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]/gu, '');
    const previous = names.get(name);
    if (previous !== undefined) throw new ImportError(`Mükerrer oyuncu: ${row.name} (satır ${previous} ve ${row.row}). Dosyadaki kayıtları düzeltin; RANK farklılığı oyuncuları ayırt etmez.`);
    names.set(name, row.row);
  }
  return file;
}
function emptyPool(w: WorkspaceSnapshot): WorkspaceSnapshot {
  if (w.manualDraftLocked || w.draftSession?.picks.length || w.rosterEntries.length) throw new ImportError('Oyuncu havuzu kilitli. Farklı dosya için Yeni çalışma başlat.');
  return { ...w, league: { ...w.league, activeDatasetId: null }, players: [], datasets: [], projections: [], eligibility: [] };
}
export function prepareManualImport(raw: RawFile, metadata: { season?: string; unit?: string }, workspace: WorkspaceSnapshot, revision: number, id: () => string, now: string): ImportPreview {
  const preview = prepareImport(normalizeManualFile(raw, metadata), emptyPool(workspace), revision, id, now);
  return { ...preview, base: workspace };
}
export function applyManualImport(preview: ImportPreview, current: WorkspaceSnapshot, revision: number) {
  if (current !== preview.base || revision !== preview.revision) throw new ImportError('Çalışma alanı değişti. Dosyayı yeniden önizleyin.');
  const base = emptyPool(current);
  return applyImport({ ...preview, base }, {}, base, revision);
}
