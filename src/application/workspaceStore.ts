import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import { selectPreparation, resetPreparation, type PreparationReset } from './workspaceCommands.ts';
import { validateWorkspace } from '../domain/rules/invariants.ts';
import type { RepositoryError, WorkspaceRepository } from './ports.ts';

export interface WorkspaceState {
  readonly load: 'loading' | 'missing' | 'loaded' | 'error';
  readonly workspace: WorkspaceSnapshot | null;
  readonly revision: number;
  readonly dirty: boolean;
  readonly conflict: boolean;
  readonly saving: boolean;
  readonly message: string;
  readonly error: RepositoryError | null;
}
/** One accepted snapshot. Async completions may update status, never restore an old snapshot. */
export class WorkspaceStore {
  private readonly session: boolean;
  private state: WorkspaceState = { load: 'loading', workspace: null, revision: 0, dirty: false, conflict: false, saving: false, message: '', error: null };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private readonly repository: WorkspaceRepository;
  constructor(repository: WorkspaceRepository, session = false) { this.repository = repository; this.session = session; }
  getSnapshot = (): WorkspaceState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<WorkspaceState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  load = (): Promise<void> => {
    if (this.loading) return this.loading;
    const revision = this.state.revision;
    this.loading = (async () => {
      try {
        const result = await this.repository.load();
        if (revision !== this.state.revision) return;
        if (!result.ok) this.update({ load: 'error', error: result.error });
        else this.update({ load: result.value ? 'loaded' : 'missing', workspace: result.value });
      } catch { if (revision === this.state.revision) this.update({ load: 'error', error: { code: 'storage-access' } }); }
    })();
    return this.loading;
  };
  accept = (workspace: WorkspaceSnapshot, replaceEntireWorkspace = false): boolean => {
    if (this.state.load === 'loading' || this.state.saving || validateWorkspace(workspace).length) return false;
    const previous = this.state.workspace;
    const wasLocked = !!previous && (previous.manualDraftLocked || selectPreparation(previous).canOpen);
    if (this.session && previous && wasLocked && !replaceEntireWorkspace) {
      const poolData = (w: WorkspaceSnapshot) => [w.players, w.datasets, w.projections, w.eligibility];
      if (workspace.league.activeDatasetId !== previous.league.activeDatasetId
        || JSON.stringify(poolData(workspace)) !== JSON.stringify(poolData(previous))) return false;
    }
    if (this.session && (workspace.manualDraftLocked || selectPreparation(workspace).canOpen || wasLocked && !replaceEntireWorkspace)) {
      workspace = { ...workspace, manualDraftLocked: true };
    }
    this.update({ workspace, revision: this.state.revision + 1, dirty: true, message: this.session ? 'Oturuma kaydediliyor…' : 'Değişiklikler bellekte. Kalıcı kayıt için Kaydet’i kullanın.' });
    if (this.session) void this.save();
    return true;
  };
  resetPreparation = (kind: PreparationReset, confirmed: boolean, revision: number): boolean => {
    if (!confirmed || revision !== this.state.revision || !this.state.workspace || this.state.saving || this.state.conflict) return false;
    try { return this.accept(resetPreparation(this.state.workspace, kind)); }
    catch { this.update({ message: 'Sıfırlama uygulanamadı. Önce kendi takımınızı seçin.' }); return false; }
  };
  resetLeague = async (confirmed: boolean, revision: number): Promise<boolean> => {
    if (!confirmed || revision !== this.state.revision || !this.state.workspace || this.state.saving || this.state.conflict || !this.repository.clear) return false;
    this.update({ saving: true });
    try {
      const result = await this.repository.clear();
      if (!result.ok) {
        this.update({ saving: false, error: result.error, conflict: result.error.code === 'storage-conflict', message: 'Lig silinemedi. Çalışmanız bellekte korunuyor.' });
        return false;
      }
      this.update({ workspace: null, revision: revision + 1, load: 'missing', dirty: false, saving: false, conflict: false, error: null, message: 'Lig ve çalışma alanı sıfırlandı.' });
      return true;
    } catch {
      this.update({ saving: false, error: { code: 'storage-access' }, message: 'Lig silinemedi. Çalışmanız bellekte korunuyor.' });
      return false;
    }
  };
  checkForChanges = async (): Promise<void> => {
    if (!this.repository.checkForChanges || this.state.load === 'loading' || this.state.saving) return;
    const revision = this.state.revision;
    try {
      const result = await this.repository.checkForChanges();
      if (revision !== this.state.revision || this.state.saving) return;
      if (!result.ok) this.update({ error: result.error });
      else if (result.value) this.update({ conflict: true, error: { code: 'storage-conflict' } });
    } catch { this.update({ error: { code: 'storage-access' } }); }
  };
  /** Explicit user decision only: never refresh working data from a storage event. */
  loadLatest = async (): Promise<void> => {
    if (this.state.saving) return;
    this.update({ saving: true });
    try {
      const result = await this.repository.load();
      if (!result.ok) this.update({ saving: false, error: result.error });
      else if (!result.value) this.update({ saving: false, error: { code: 'storage-conflict' }, message: 'Güncel kayıt bulunamadı. Bellekteki çalışma korundu.' });
      else this.update({ workspace: result.value, revision: this.state.revision + 1, load: 'loaded', saving: false, dirty: false, conflict: false, error: null, message: 'Güncel tarayıcı kaydı yüklendi.' });
    } catch { this.update({ saving: false, error: { code: 'storage-access' } }); }
  };
  save = async (): Promise<void> => {
    const { workspace, revision, saving } = this.state;
    if (!workspace || saving) return;
    if (this.state.conflict) { this.update({ error: { code: 'storage-conflict' } }); return; }
    this.update({ saving: true, message: 'Kaydediliyor…', error: null });
    try {
      const result = await this.repository.save(workspace);
      if (!result.ok) this.update({ saving: false, dirty: true, conflict: result.error.code === 'storage-conflict' || this.state.conflict, error: result.error, message: 'Kaydedilemedi. Çalışmanız bellekte korunuyor; JSON yedeğini indirin.' });
      else this.update({ load: 'loaded', saving: false, dirty: this.state.revision !== revision, message: this.state.revision === revision ? 'Çalışma alanı kaydedildi.' : 'Önceki sürüm kaydedildi. Yeni değişiklikleri kaydedin.' });
    } catch { this.update({ saving: false, dirty: true, error: { code: 'storage-access' }, message: 'Kaydedilemedi. Çalışmanız bellekte korunuyor; JSON yedeğini indirin.' }); }
  };
}
