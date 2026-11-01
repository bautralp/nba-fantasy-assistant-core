import type { WorkspaceSnapshot } from '../../domain/models/workspace';
import { draftStatus } from '../../application/draftSelectors';
export function DraftStatusBar({ workspace: w }: { workspace: WorkspaceSnapshot }) {
  const s = draftStatus(w);
  return <div className="draft-status" role="status" aria-label="Draft sırası">
    <span>{w.teams.find(t => t.id === w.league.userTeamId)?.name ?? 'Takım seçilmedi'} · Draft sıran: {s.userPosition ?? '—'}</span>
    <strong>{s.completed ? `Draft tamamlandı · ${s.count}/${s.total}` : `Seçim ${s.next}/${s.total} · Tur ${s.round} · Sıradaki: ${w.teams.find(t => t.id === s.teamId)?.name ?? '—'}`}</strong>
    <span>Tamamlanan: {s.count}/{s.total}</span>
  </div>;
}
