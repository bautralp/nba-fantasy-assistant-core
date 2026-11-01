import type { RepositoryError, Result, WorkspaceRepository } from '../../application/ports.ts';
import type { WorkspaceSnapshot } from '../../domain/models/workspace.ts';
import { exportWorkspaceJson, restoreWorkspaceJson } from './workspaceJson.ts';

/** Only this single application-owned key is read; no legacy key discovery. */
export const WORKSPACE_STORAGE_KEY = 'nba-fantasy-assistant.workspace.v1';
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  removeItem?(key: string): void;
  setItem(key: string, value: string): void;
}
function storageError(error: unknown): RepositoryError {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  return { code: name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ? 'storage-quota' : 'storage-access' };
}
export class LocalStorageWorkspaceRepository implements WorkspaceRepository {
  private readonly key: string;
  private baseline: string | null | undefined;
  private readonly getStorage: () => WorkspaceStorage;
  /** Lazy access catches errors thrown by the browser's localStorage getter too. */
  constructor(getStorage: () => WorkspaceStorage = () => globalThis.localStorage, key = WORKSPACE_STORAGE_KEY) { this.getStorage = getStorage; this.key = key; }

  async load(): Promise<Result<WorkspaceSnapshot | null, RepositoryError>> {
    let text: string | null;
    try { text = this.getStorage().getItem(this.key); }
    catch (error) { return { ok: false, error: storageError(error) }; }
    const result = text === null ? { ok: true as const, value: null } : restoreWorkspaceJson(text);
    if (result.ok) this.baseline = text;
    return result;
  }

  async checkForChanges(): Promise<Result<boolean, RepositoryError>> {
    try { return { ok: true, value: this.baseline !== undefined && this.getStorage().getItem(this.key) !== this.baseline }; }
    catch (error) { return { ok: false, error: storageError(error) }; }
  }

  /** Delete only a successfully observed valid record. Failure retains the working snapshot. */
  async clear(): Promise<Result<void, RepositoryError>> {
    try {
      const storage = this.getStorage();
      const existing = storage.getItem(this.key);
      if (this.baseline === undefined || existing !== this.baseline) return { ok: false, error: { code: 'storage-conflict' } };
      if (existing !== null) {
        const checked = restoreWorkspaceJson(existing);
        if (!checked.ok) return { ok: false, error: { code: 'existing-record-invalid', reason: checked.error } };
        if (!storage.removeItem) return { ok: false, error: { code: 'storage-access' } };
        storage.removeItem(this.key);
      }
      this.baseline = null;
      return { ok: true, value: undefined };
    } catch (error) { return { ok: false, error: storageError(error) }; }
  }

  async save(snapshot: WorkspaceSnapshot): Promise<Result<void, RepositoryError>> {
    const encoded = exportWorkspaceJson(snapshot);
    if (!encoded.ok) return encoded;
    try {
      const storage = this.getStorage();
      const existing = storage.getItem(this.key);
      if (existing !== null) {
        const checked = restoreWorkspaceJson(existing);
        if (!checked.ok) return { ok: false, error: { code: 'existing-record-invalid', reason: checked.error } };
      }
      // Best-effort optimistic guard; localStorage has no atomic compare-and-swap.
      // Without a successful load, only an absent record is safe to create.
      if (existing !== (this.baseline ?? null)) return { ok: false, error: { code: 'storage-conflict' } };
      // One native setItem: a failed write leaves the previous value intact.
      // No delete-first, temporary keys or misleading success after exceptions.
      storage.setItem(this.key, encoded.value);
      this.baseline = encoded.value;
      return { ok: true, value: undefined };
    } catch (error) { return { ok: false, error: storageError(error) }; }
  }
}
