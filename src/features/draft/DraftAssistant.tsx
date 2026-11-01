import { useMemo, useState } from 'react';
import { useWorkspace } from '../../app/WorkspaceContext';
import { selectDraftWorkspace } from '../../application/draftSelectors';
import { applyDraftCommand } from '../../application/draftCommands';
import { PlayerPoolTable } from './PlayerPoolTable';
import { RecommendationsPanel } from './RecommendationsPanel';
import { PlayerAssignmentDialog } from './PlayerAssignmentDialog';
import { DraftDialog } from './DraftDialog';
import { selectDraftAnalysis } from '../../application/analysisSelectors';
import { CategoryPowerRankings } from '../analysis/CategoryPowerRankings';
import { CategoryAnalysisPanel } from '../analysis/CategoryAnalysisPanel';
import { OpponentAnalysisPanel } from '../analysis/OpponentAnalysisPanel';
import { RosterOverview } from '../rosters/RosterOverview';
export const DRAFT_VIEW_KEY = 'nba-fantasy-assistant.draft-view.v1';
export function DraftAssistant({ onStrategy }: { onStrategy: () => void }) {
  const { workspace, revision, saving, store } = useWorkspace();
  const view = useMemo(() => workspace ? selectDraftWorkspace(workspace) : null, [workspace]);
  const analysis = useMemo(() => workspace && view ? selectDraftAnalysis(workspace, view) : null, [workspace, view]);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [tab, setTab] = useState(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(DRAFT_VIEW_KEY) ?? 'null'); if (saved?.leagueId === workspace?.league.id && Number.isInteger(saved?.tab) && saved.tab >= 0 && saved.tab < 4) return saved.tab as number; } catch { /* The workspace repository reports data storage failures separately. */ }
    return 0;
  });
  const tabs = ['Draft', 'Power Rankings', 'Takım Kadroları', 'Kategori / Rakip Analizi'];
  const [undo, setUndo] = useState<{ playerId: string; revision: number } | null>(null), [message, setMessage] = useState('');
  if (!workspace || !view || !analysis) return null;
  const chooseTab = (index: number) => {
    setTab(index);
    try { sessionStorage.setItem(DRAFT_VIEW_KEY, JSON.stringify({ leagueId: workspace.league.id, tab: index })); }
    catch { setMessage('Sekme tercihi oturuma kaydedilemedi. Draft verileri bellekte korunuyor.'); }
  };
  const last = workspace.draftSession?.picks.at(-1);
  return <section aria-label="Draft Assistant" className="draft-assistant">
    <div className="actions draft-actions"><button disabled={saving || !workspace.league.userTeamId} onClick={onStrategy}>Strateji</button><button disabled={saving || !last} onClick={() => last && setUndo({ playerId: last.playerId, revision })}>Son seçimi geri al</button></div>
    {message && <p role="status" className="operation-message">{message}</p>}
    <div className="workspace-tabs" role="tablist" aria-label="Çalışma alanı sekmeleri">{tabs.map((name, index) => <button key={name} role="tab" id={`tab-${index}`} aria-controls={`pane-${index}`} aria-selected={tab === index} tabIndex={tab === index ? 0 : -1} onClick={() => chooseTab(index)} onKeyDown={event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); chooseTab(next); document.getElementById(`tab-${next}`)?.focus(); }
    }}>{name}</button>)}</div>
    <div role="tabpanel" id="pane-0" aria-labelledby="tab-0" hidden={tab !== 0}>
    <div className="draft-columns"><PlayerPoolTable workspace={workspace} view={view} onPlayer={setPlayerId} /><RecommendationsPanel workspace={workspace} view={view} onPlayer={setPlayerId} /></div>
    </div>
    <div role="tabpanel" id="pane-1" aria-labelledby="tab-1" hidden={tab !== 1}><CategoryPowerRankings analysis={analysis} /></div>
    <div role="tabpanel" id="pane-2" aria-labelledby="tab-2" hidden={tab !== 2}><RosterOverview analysis={analysis} onPlayer={setPlayerId} /></div>
    <div role="tabpanel" id="pane-3" aria-labelledby="tab-3" hidden={tab !== 3}>
    <section className="panel analysis-section" aria-label="Detaylı kategori ve rakip analizi"><details open><summary><h2>Detaylı kategori / rakip analizi</h2></summary>
      <CategoryAnalysisPanel analysis={analysis} view={view} workspace={workspace} />
      <OpponentAnalysisPanel analysis={analysis} view={view} />
    </details></section></div>
    {playerId && <PlayerAssignmentDialog playerId={playerId} view={view} onClose={() => setPlayerId(null)} onSuccess={setMessage} />}

    {undo && <DraftDialog title="Son seçimi geri al" onClose={() => setUndo(null)}>
      <p>{workspace.players.find(p => p.id === undo.playerId)?.name} · {workspace.teams.find(t => t.id === last?.teamId)?.name}. Bu son seçim kaldırılsın mı?</p>
      {undo.revision !== revision && <p role="alert">Çalışma alanı değişti. Yeniden inceleyin.</p>}
      <div className="actions"><button disabled={saving || undo.revision !== revision} onClick={() => {
        try {
          const current = store.getSnapshot();
          if (!current.workspace || undo.revision !== current.revision) throw new Error('Çalışma alanı değişti.');
          if (!store.accept(applyDraftCommand(current.workspace, { kind: 'undo', playerId: undo.playerId }))) throw new Error('Geri alma uygulanamadı.');
          setUndo(null); setMessage('Son seçim geri alındı.');
        } catch (e) { setMessage(e instanceof Error ? e.message : 'İşlem uygulanamadı.'); }
      }}>Seçimi geri almayı onayla</button><button onClick={() => setUndo(null)}>İptal</button></div>
    </DraftDialog>}
  </section>;
}
