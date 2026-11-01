import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { WorkspaceStore } from '../application/workspaceStore';
import { LocalStorageWorkspaceRepository } from '../infrastructure/persistence/localStorageWorkspaceRepository';
const WorkspaceContext = createContext<WorkspaceStore | null>(null);
export const SESSION_KEY = 'nba-fantasy-assistant.session.v1';
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WorkspaceStore(new LocalStorageWorkspaceRepository(() => globalThis.sessionStorage, SESSION_KEY), true));
  useEffect(() => {
    void store.load();
    const check = () => { void store.checkForChanges(); };
    const storage = (event: StorageEvent) => { if (event.key === SESSION_KEY || event.key === null) check(); };
    const visibility = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('storage', storage); window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visibility); };
  }, [store]);
  return <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>;
}
export function useWorkspace() {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error('WorkspaceProvider required');
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...state, store };
}
