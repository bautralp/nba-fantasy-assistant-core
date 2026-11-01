import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import type { Player } from '../domain/models/player.ts';
import type { PlayerProjection, ProjectionDataset } from '../domain/models/projection.ts';
import type { PositionEligibility } from '../domain/models/roster.ts';
import { validateWorkspace } from '../domain/rules/invariants.ts';
import { ImportError, type NormalizedFile, type NormalizedRow } from './projectionRows.ts';

export interface IdentityRow { data: NormalizedRow; newId: string; automaticId?: string; problem?: string; candidates: string[] }
export interface ImportPreview { file: NormalizedFile; revision: number; base: WorkspaceSnapshot; datasetId: string; importedAt: string; rows: IdentityRow[] }
export type IdentityDecision = { kind: 'new' } | { kind: 'match'; playerId: string } | { kind: 'skip' };
export type Decisions = Readonly<Record<number, IdentityDecision>>;
export function prepareImport(file: NormalizedFile, workspace: WorkspaceSnapshot, revision: number, id: () => string, importedAt: string): ImportPreview {
  if (file.season !== workspace.league.season) throw new ImportError('Dosyanın sezonu lig sezonuyla uyuşmuyor.');
  const datasetId = id(); const used = new Set(workspace.players.map(p => p.id));
  const reserved = new Set([...used, ...file.rows.map(r => r.externalId).filter(Boolean)]);
  const counts = new Map<string, number>();
  file.rows.forEach(r => { if (r.externalId) counts.set(r.externalId, (counts.get(r.externalId) ?? 0) + 1); });
  const rows = file.rows.map(data => {
    // Invalid identities are neither empty IDs nor candidates for UUID allocation.
    if (data.identityError) return { data, newId: '', problem: data.identityError, candidates: [] };
    const exact = workspace.players.find(p => p.id === data.externalId);
    const providers = workspace.players.filter(p => Object.values(p.providerIds ?? {}).includes(data.externalId) && data.externalId !== '');
    const trustedProvider = providers.length === 1 && providers[0].providerIds?.projectionFile === data.externalId ? providers[0] : undefined;
    const names = workspace.players.filter(p => p.name.toLocaleLowerCase() === data.name.toLocaleLowerCase());
    const candidates = [...new Set([...providers, ...names, ...(exact ? [exact] : [])].map(p => p.id))];
    const duplicate = data.externalId && (counts.get(data.externalId) ?? 0) > 1;
    let problem: string | undefined;
    if (duplicate) problem = 'Mükerrer PLAYER_ID; her satır için açık karar gerekli.';
    else if (exact && providers.some(p => p.id !== exact.id) || !exact && providers.length > 1) problem = 'PLAYER_ID birden fazla kalıcı oyuncuya işaret ediyor; açık karar gerekli.';
    else if (!exact && !trustedProvider && (providers.length || names.length || !data.externalId && workspace.players.length > 0)) problem = 'Eksik ID, ad veya sağlayıcı kimliği otomatik eşleşmez; mevcut oyuncuyu seçin veya yeni oyuncu oluşturun.';
    // A unique, unambiguous supplied ID can establish a new identity.
    // Ambiguous rows and explicit 'new' overrides receive independent application IDs.
    const suppliedNew = Boolean(data.externalId && !problem && !exact);
    const newId = suppliedNew ? data.externalId : id();
    if (!newId.trim() || used.has(newId) || !suppliedNew && reserved.has(newId)) throw new ImportError('Yeni kimlik üretimi çakıştı.');
    used.add(newId);
    return { data, newId, ...(!problem && (exact || trustedProvider) ? { automaticId: exact?.id ?? trustedProvider!.id } : {}), ...(problem ? { problem } : {}), candidates };
  });
  if (!datasetId.trim() || workspace.datasets.some(d => d.id === datasetId)) throw new ImportError('Veri seti kimliği çakıştı.');
  return { file, revision, base: workspace, datasetId, importedAt, rows };
}
export function inspectImport(preview: ImportPreview, decisions: Decisions) {
  const resolved = preview.rows.map(row => {
    const decision = decisions[row.data.row];
    const skipped = decision?.kind === 'skip';
    const playerId = row.data.identityError ? undefined : decision?.kind === 'match' ? decision.playerId : decision?.kind === 'new' ? row.newId : row.automaticId ?? (!row.problem ? row.newId : undefined);
    return { ...row, skipped, playerId };
  });
  const errors: string[] = [];
  const seen = new Set<string>();
  resolved.filter(r => !r.skipped).forEach(r => {
    if (r.data.identityError) errors.push(`Satır ${r.data.row} · PLAYER_ID: ${r.data.identityError}`);
    else if (!r.playerId) errors.push(`Satır ${r.data.row}: kimlik kararı gerekli.`);
    else if (seen.has(r.playerId)) errors.push(`Satır ${r.data.row}: aynı oyuncuya birden fazla satır bağlanamaz.`);
    else { seen.add(r.playerId); if (r.playerId !== r.newId && !preview.base.players.some(p => p.id === r.playerId)) errors.push(`Satır ${r.data.row}: oyuncu bulunamadı.`); }
    if (!r.data.name && !preview.base.players.some(p => p.id === r.playerId)) errors.push(`Satır ${r.data.row}: yeni oyuncu için ad gerekli; satırı dışarıda bırakın.`);
  });
  if (!resolved.some(r => !r.skipped)) errors.push('En az bir oyuncu satırı gerekli.');
  const assigned = new Set((preview.base.draftSession?.picks ?? preview.base.rosterEntries).map(p => p.playerId));
  const activeIds = new Set(preview.base.projections.filter(p => p.datasetId === preview.base.league.activeDatasetId).map(p => p.playerId));
  const missingPicked = preview.base.players.filter(p => assigned.has(p.id) && !seen.has(p.id));
  const removed = preview.base.players.filter(p => activeIds.has(p.id) && !assigned.has(p.id) && !seen.has(p.id));
  const included = resolved.filter(r => !r.skipped);
  return { resolved, errors, missingPicked, removed, total: preview.file.rowCount, skipped: preview.file.rowCount - included.length,
    newPlayers: included.filter(r => r.playerId === r.newId).length,
    updated: included.filter(r => r.playerId && r.playerId !== r.newId).length,
    valid: included.filter(r => !r.data.issues.some(i => i.level === 'row')).length,
    excluded: included.filter(r => r.data.issues.some(i => i.level === 'row')).length };
}
/** Pure transaction: preserve draft, ownership, historical datasets and IDs verbatim. */
export function applyImport(preview: ImportPreview, decisions: Decisions, current: WorkspaceSnapshot, revision: number): WorkspaceSnapshot {
  if (revision !== preview.revision || current !== preview.base) throw new ImportError('Çalışma alanı değişti. Dosyayı yeniden önizleyin.');
  const review = inspectImport(preview, decisions);
  if (review.errors.length) throw new ImportError(review.errors.join(' '));
  const players: Player[] = [...current.players]; const projections: PlayerProjection[] = []; const eligibility: PositionEligibility[] = [];
  for (const row of review.resolved) {
    if (row.skipped || !row.playerId) continue;
    const data = row.data;
    if (!players.some(p => p.id === row.playerId)) players.push({ id: row.playerId, name: data.name, ...(data.externalId ? { providerIds: { projectionFile: data.externalId } } : {}) });
    const reasons = data.issues.filter(i => i.level === 'row').map(i => `${i.field}: ${i.message}`);
    const identity = { playerId: row.playerId, datasetId: preview.datasetId, ...(data.presentation ? { presentation: data.presentation } : {}), ...(data.rank ? { rank: data.rank } : {}) };
    projections.push(reasons.length ? { ...identity, status: 'excluded', reasons } : { ...identity, status: 'valid', gamesPlayed: data.gamesPlayed!, stats: data.stats });
    eligibility.push({ playerId: row.playerId, season: preview.file.season, scope: { kind: 'dataset', datasetId: preview.datasetId }, positions: data.positions });
  }
  const rankInputIssue = review.resolved.some(r => !r.skipped && r.data.issues.some(i => i.field === 'RANK')) ? { rankInputIssue: 'invalid' as const } : {};
  const dataset: ProjectionDataset = { ...rankInputIssue, id: preview.datasetId, schemaVersion: 1, season: preview.file.season, unit: preview.file.unit, importedAt: preview.importedAt, source: { name: preview.file.name, kind: preview.file.format === 'xlsx' ? 'excel' : preview.file.format } };
  const snapshot: WorkspaceSnapshot = { ...current, league: { ...current.league, activeDatasetId: dataset.id }, players, datasets: [...current.datasets, dataset], projections: [...current.projections, ...projections], eligibility: [...current.eligibility, ...eligibility] };
  const issues = validateWorkspace(snapshot); if (issues.length) throw new ImportError(`Çalışma alanı doğrulanamadı: ${issues.map(i => i.path).join(', ')}`);
  return snapshot;
}
