import { SeasonAssistant } from '../features/season/SeasonAssistant';
import { transition } from '../shared/transition';
import { DRAFT_VIEW_KEY } from '../features/draft/DraftAssistant';
import { describeError } from '../application/errorMessages';
import { selectPreparation } from '../application/workspaceCommands';
import { useState } from 'react';
import { useWorkspace } from './WorkspaceContext';
import { WorkspaceScreen } from './WorkspaceScreen';
import { CentralRankings } from '../features/rankings/CentralRankings';
import { DraftDialog } from '../features/draft/DraftDialog';

type Section = 'rankings' | 'draft' | 'season';
type Page = 'home' | 'source' | 'central' | 'manual';
const NAV_KEY = 'nba-fantasy-assistant.navigation.v1';
/** Session key of the removed rankings upload screen; new work still clears leftovers from older tabs. */
const LEGACY_RANKINGS_SESSION_KEY = 'nba-fantasy-assistant.rankings-session.v1';
const sections = [
  { id: 'rankings', title: 'Oyuncu Sıralamaları', description: 'Oyuncu sıralamalarını ve istatistiklerini incele.' },
  { id: 'draft', title: 'Draft Asistanı', description: 'Ligini oluştur, stratejini belirle ve draftını yönet.' },
  { id: 'season', title: 'Sezon İçi Asistanı', description: 'Lig, takım, waiver ve takas analizleri.' },
] as const;
export function ApplicationMenu() {
  const { store, workspace, load, saving, error } = useWorkspace();
  const [nav, setNav] = useState<{ page: Page; section: Section; centralSource?: 'lastSeason' | 'projected' }>(() => {
    try { const v = JSON.parse(sessionStorage.getItem(NAV_KEY) ?? 'null'); if (v && ['home', 'source', 'central', 'manual'].includes(v.page) && ['rankings', 'draft', 'season'].includes(v.section) && (v.centralSource === undefined || ['lastSeason', 'projected'].includes(v.centralSource))) return v.section === 'rankings' && v.page !== 'home' ? { ...v, page: 'central' } : v; } catch { /* Workspace errors remain visible through its store. */ }
    return { page: 'home', section: 'draft' };
  });
  const [centralOpened, setCentralOpened] = useState(nav.page === 'central' && nav.section === 'rankings');
  const [navError, setNavError] = useState('');
  const [newWork, setNewWork] = useState(false), [confirmed, setConfirmed] = useState(false), [generation, setGeneration] = useState(0);
  const [resetRevision, setResetRevision] = useState(0);
  const go = (page: Page, section = nav.section, centralSource = nav.centralSource) => {
    if (page === 'central' && section === 'rankings') setCentralOpened(true);
    const next = { page, section, centralSource }; transition(() => { setNav(next);
    requestAnimationFrame(() => (document.getElementById((page === 'manual' || page === 'central') && section === 'draft' ? 'page-heading-draft' : page === 'central' && section === 'rankings' ? 'central-rankings-heading' : page === 'manual' && section === 'rankings' ? 'rankings-heading' : 'page-heading'))?.focus());
    });
    try { sessionStorage.setItem(NAV_KEY, JSON.stringify(next)); setNavError(''); } catch { setNavError('Ekran durumu oturuma kaydedilemedi. Bellekteki çalışma korunuyor; Acil JSON kurtarma ile yedek alabilirsin.'); }

  };
  const startNew = async () => {
    if (!confirmed || saving || resetRevision !== store.getSnapshot().revision) return;
    if (workspace && !await store.resetLeague(true, resetRevision)) return;
    try { sessionStorage.removeItem(LEGACY_RANKINGS_SESSION_KEY); sessionStorage.removeItem(DRAFT_VIEW_KEY); }
    catch {
      setNavError('Sıralama oturumu temizlenemedi. Bellekteki sıralama korundu. Yeni çalışma işlemini tekrar deneyebilirsin.');
      setResetRevision(store.getSnapshot().revision);
      return;
    }
    setNewWork(false); setGeneration(g => g + 1); go('home');
  };
  const draftLocked = !!workspace?.manualDraftLocked || selectPreparation(workspace).canOpen;
  const title = sections.find(s => s.id === nav.section)!.title;
  return <div className={`app-shell ${nav.page === 'home' ? 'is-home' : 'is-inner'}`}>
    <header className="app-header"><h1><a className="brand-link" href={import.meta.env.BASE_URL} title="Ana menüye dön" aria-current={nav.page === 'home' ? 'page' : undefined} onClick={event => {
      // Modified clicks keep normal browser link behavior (new tab/window).
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); go('home');
    }}>NBA Fantasy Assistant</a></h1></header>
    <main>
      <nav className="actions main-navigation" aria-label="Ana navigasyon">{nav.page !== 'home' && nav.page !== 'source' && nav.section === 'draft' && <button onClick={() => go('source')}>Veri kaynağı seçimine dön</button>}
      {workspace && <button onClick={() => { setConfirmed(false); setResetRevision(store.getSnapshot().revision); setNewWork(true); }}>Yeni çalışma başlat</button>}</nav>
      {nav.section !== 'season' && !(nav.page === 'central' && nav.section === 'rankings') && <p className="muted session-note">Manuel çalışmalar bu sekmenin oturumunda otomatik saklanır. Yenilemede devam edebilirsin; sekme veya tarayıcı oturumu sona erdiğinde kalıcılık garanti edilmez.</p>}
      {navError && <p role="alert">{navError}</p>}
      {nav.page === 'home' && <><h2 id="page-heading" tabIndex={-1}>Nasıl devam etmek istersin?</h2><div className="main-cards">{sections.map(s => <button key={s.id} className="main-card" onClick={() => go(s.id === 'rankings' ? 'central' : 'source', s.id)}><strong>{s.title}</strong><span>{s.description}</span></button>)}</div></>}
      {nav.page === 'source' && nav.section !== 'season' && <><h2 id="page-heading" tabIndex={-1}>Veri kaynağını seç</h2><p>{title}</p>
        {nav.section === 'draft' && workspace && <button className="primary" onClick={() => go('manual')}>Mevcut çalışmaya devam et</button>}
        {nav.section === 'draft' && draftLocked && <p className="notice">Bu draftta veri kaynağı değiştirilemez. Mevcut çalışmaya devam et veya Yeni çalışma başlat.</p>}
        {/* One Fantasy Assistant entry: the pool panel starts at 2026-27 ROS and still offers Actual and the extended scenario. */}
        <div className="source-cards"><button className="main-card" disabled={draftLocked} onClick={() => go('central', 'draft', 'projected')}><strong>Fantasy Assistant verilerini kullan</strong><span>Dosya gerekmez. Oyuncu havuzu 2026-27 ROS projeksiyonlarıyla hazırlanır; istersen 2025-26 gerçek istatistiklerini veya genişletilmiş tahmini seçebilirsin.</span><small>Varsayılan: 2026-27 Projected — ROS</small></button>
        <button className="main-card" onClick={() => go('manual')}><strong>Kendim yükleyeceğim</strong><span>Bu çalışma için kendi Excel, CSV veya JSON dosyanı kullan.</span></button></div></>}
      <div hidden={nav.page !== 'central' || nav.section !== 'rankings'}>{centralOpened && <CentralRankings />}</div>
      {nav.page !== 'home' && nav.section === 'season' && <SeasonAssistant />}
      <div hidden={!(nav.page === 'manual' || nav.page === 'central') || nav.section !== 'draft'}><h2 id="page-heading-draft" tabIndex={-1}>Draft Asistanı</h2><WorkspaceScreen key={generation} centralSource={nav.page === 'central' ? nav.centralSource ?? 'projected' : undefined} /></div>
      {load === 'error' && nav.page !== 'manual' && <p role="alert">Oturum kaydı okunamadı. Draft Asistanı içindeki Acil JSON kurtarma alanını kullanabilirsin.</p>}
      {newWork && <DraftDialog title="Yeni çalışma başlat" onClose={() => setNewWork(false)}><p>Draft çalışma alanının tamamı silinecek. Bu işlem geri alınamaz. Eski localStorage kayıtların korunur.</p>{(error || navError) && <p role="alert">{error ? describeError(error) : navError}</p>}<label className="check-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Mevcut çalışmamı silmeyi açıkça onaylıyorum.</label><button disabled={!confirmed || saving || resetRevision !== store.getSnapshot().revision} onClick={() => void startNew()}>Yeni çalışmayı onayla</button><button onClick={() => setNewWork(false)}>İptal</button></DraftDialog>}
    </main>
  </div>;
}
