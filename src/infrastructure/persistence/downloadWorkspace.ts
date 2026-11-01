import type { WorkspaceSnapshot } from '../../domain/models/workspace';
import { exportWorkspaceJson } from './workspaceJson';
/** Browser-only delivery; encoding and validation remain in the existing JSON adapter. */
export function downloadWorkspace(snapshot: WorkspaceSnapshot): string | null {
  const result = exportWorkspaceJson(snapshot);
  if (!result.ok) return 'JSON yedeği oluşturulamadı.';
  let url: string | undefined;
  try {
    url = URL.createObjectURL(new Blob([result.value], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'nba-fantasy-workspace.json';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Keep the object URL alive until the browser has started the download.
    const downloadUrl = url;
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    return null;
  } catch {
    if (url) URL.revokeObjectURL(url);
    return 'İndirme başlatılamadı; tarayıcı izinlerini kontrol edin.';
  }
}
