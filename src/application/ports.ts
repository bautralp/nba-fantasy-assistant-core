import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import type { IntegrityIssue } from '../domain/rules/invariants.ts';

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export type WorkspaceDataError =
  | { readonly code: 'invalid-json' }
  | { readonly code: 'unsupported-schema'; readonly path: string }
  | { readonly code: 'invalid-data'; readonly issues: readonly IntegrityIssue[] }
  | { readonly code: 'serialization' };
export type RepositoryError = WorkspaceDataError
  | { readonly code: 'storage-access' | 'storage-quota' | 'storage-conflict' }
  | { readonly code: 'existing-record-invalid'; readonly reason: WorkspaceDataError };

/** No record is a successful null result; unreadable/invalid records are errors.
 * Implementations never mutate the supplied workspace, including on failure.
 * Promise-based so IndexedDB can implement the same contract.
 */
export interface WorkspaceRepository {
  clear?(): Promise<Result<void, RepositoryError>>;
  checkForChanges?(): Promise<Result<boolean, RepositoryError>>;
  load(): Promise<Result<WorkspaceSnapshot | null, RepositoryError>>;
  save(snapshot: WorkspaceSnapshot): Promise<Result<void, RepositoryError>>;
}
