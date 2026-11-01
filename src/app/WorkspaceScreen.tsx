import { CentralDatasetPanel } from '../features/data/CentralDatasetPanel';
import type { CentralSource } from '../application/centralDataset';
import { useEffect, useRef, useState } from 'react';
import { PlayerImportPanel } from '../features/data/PlayerImportPanel';
import { DraftStatusBar } from '../features/draft/DraftStatusBar';
import { DraftAssistant } from '../features/draft/DraftAssistant';
import { StrategyDialog } from '../features/draft/StrategyDialog';
import { DraftDialog } from '../features/draft/DraftDialog';
import { LeagueForm } from '../features/league/LeagueForm';
import { EspnLeagueImportDialog } from '../features/league/EspnLeagueImportDialog';
import { blankLeagueSettings, type LeagueSettings } from '../application/leagueSetup';
import { settingsFromEspn, type DraftSupport } from '../application/espnLeagueImport';
import { BackupPanel } from '../features/backup/BackupPanel';
import { describeError } from '../application/errorMessages';
import { selectPreparation } from '../application/workspaceCommands';
import { createUnsetTargets } from '../domain/models/categories';
import { useWorkspace } from './WorkspaceContext';
import './App.css';

type Editor = 'league' | 'strategy' | 'pool' | null;
type Reset = { revision: number };
export function WorkspaceScreen({ centralSource }: { centralSource?: CentralSource }) {
  const { load, workspace, dirty, saving, conflict, message, error, revision, store } = useWorkspace();
  const [replaceExternal, setReplaceExternal] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [reset, setReset] = useState<Reset | null>(null), [confirmed, setConfirmed] = useState(false);
  const [recovery, setRecovery] = useState(false);
  // New leagues start with the ESPN lookup dialog; the form opens prefilled or blank afterwards.
  const [importing, setImporting] = useState(false), [imported, setImported] = useState<{ settings: LeagueSettings; support: Extract<DraftSupport, { ok: true }>; key: number } | null>(null);
  const prep = selectPreparation(workspace);
  const locked = !!workspace?.manualDraftLocked || prep.canOpen;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const openEditor = (next: Editor, trigger?: HTMLElement) => { opener.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); setEditor(next); };
  const closeEditor = () => { setEditor(null); setImported(null); requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus(); else document.getElementById('settings-trigger')?.focus(); }); };
  useEffect(() => { if (editor === 'league') document.getElementById('setup-heading')?.focus(); }, [editor]);
  const targets = workspace?.strategies.find(s => s.teamId === workspace.league.userTeamId)?.targets ?? createUnsetTargets();

  return <>
    {editor === 'league' && <div className="league-page">{load === 'error' && <p role="alert" className="notice">Mevcut tarayıcı kaydı yüklenemedi. Otomatik silinmedi veya değiştirilmedi. Yeni çalışma bellekte korunur.</p>}{error && <p role="alert" className="field-error">{describeError(error)}</p>}<button onClick={closeEditor}>← Draft hazırlığına dön</button><LeagueForm key={`league-${workspace?.league.id ?? `new-${imported?.key ?? 0}`}`} onClose={closeEditor} initial={workspace ? undefined : imported?.settings}
      notice={!workspace && imported ? <div role="status" className="notice league-import-notice"><p>ESPN’den aktarıldı: <strong>{imported.support.name}</strong> · {imported.support.teams.length} takım. Kendi takımını seç. {imported.support.draftOrder ? 'Draft sırası ESPN’den aktarıldı; gerekirse düzenleyebilirsin.' : 'Draft sırasını kontrol et.'}</p>{imported.support.notes.map(n => <p key={n}>{n}</p>)}</div> : undefined} /></div>}
    {importing && <EspnLeagueImportDialog onClose={() => setImporting(false)}
      onManual={() => { setImporting(false); setImported(null); setEditor('league'); }}
      onImported={support => { setImporting(false); setImported(previous => ({ support, settings: settingsFromEspn(support, { ...blankLeagueSettings(), season: '2026-27' }), key: (previous?.key ?? 0) + 1 })); setEditor('league'); }} />}
    <div hidden={editor === 'league'}>
    {load === 'loading' ? <p role="status">Çalışma alanı yükleniyor…</p> : <>
      {load === 'error' && <p role="alert" className="notice">Mevcut tarayıcı kaydı yüklenemedi. Otomatik silinmedi veya değiştirilmedi. Yeni çalışma bellekte tutulabilir; bozuk kaydın üzerine yazılmaz.</p>}
      {error && <p role="alert" className="field-error">{describeError(error)}</p>}
      <p role="status" className="operation-message">{message}{saving ? '' : dirty ? ' Kaydedilmemiş çalışma var.' : ''}</p>
      {conflict && <div role="alert" className="notice conflict-notice">
        <p>Başka bir sekmede kayıt değişti. Bu sekmenin çalışması bellekte korundu; kaydetme durduruldu.</p>
        <p>Önce Acil JSON kurtarma ile bellekteki çalışmayı indirin. Güncel kaydı yüklemek bu sekmenin bellekteki çalışmasını değiştirir.</p>
        <label className="check-label"><input type="checkbox" checked={replaceExternal} onChange={e => setReplaceExternal(e.target.checked)} />Bellekteki çalışmamın güncel tarayıcı kaydıyla değiştirilmesini onaylıyorum.</label>
        <button disabled={!replaceExternal || saving} onClick={() => { setReplaceExternal(false); setEditor(null); void store.loadLatest(); }}>Güncel tarayıcı kaydını yükle</button>
      </div>}
      {workspace?.datasets.find(d => d.id === workspace.league.activeDatasetId)?.provenance && <p className="notice">Sabit kaynak: {workspace.datasets.find(d => d.id === workspace.league.activeDatasetId)!.source.name} · Kaynak tarihi: {workspace.datasets.find(d => d.id === workspace.league.activeDatasetId)!.provenance!.asOf} · Lig sezonu: {workspace.league.season}</p>}
      {workspace && <section className="panel league-summary" aria-labelledby="league-heading">
        <div className="module-heading"><h2 tabIndex={-1} id="league-heading">{workspace.league.name || 'İsimsiz lig'}</h2><span className="status-label">{workspace.league.season} · {dirty ? 'Kaydedilmedi' : 'Kayıtlı çalışma'}</span></div>
        <DraftStatusBar workspace={workspace} />
        <div className="actions"><button className="primary" disabled={saving || conflict} onClick={() => void store.save()}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
          <details className="settings"><summary id="settings-trigger">Ayarlar</summary><div className="settings-items">
            <button disabled={saving} onClick={event => openEditor('league', event.currentTarget)}>Lig bilgilerini düzenle</button>
            <button disabled={saving || !prep.league} onClick={event => openEditor('strategy', event.currentTarget)}>Stratejiyi düzenle</button>
            <button disabled={saving || !prep.league || locked} onClick={event => openEditor('pool', event.currentTarget)}>Oyuncu havuzunu değiştir</button>
            <button disabled={saving || conflict} onClick={() => { setConfirmed(false); setReset({ revision }); }}>Stratejiyi sıfırla</button>
          </div></details>
        </div>
      </section>}
      {!prep.ready && <section aria-labelledby="preparation-heading" className="preparation">
        <h2 id="preparation-heading">Draft için hazırlan</h2>
        <p className="muted">Ligini oluştur; ardından stratejini ve oyuncu havuzunu istediğin sırada hazırla.</p>
        <div className="setup-steps">{([
          ['league', 'Ligini oluştur', prep.league], ['strategy', 'Stratejini belirle', prep.strategy], ['pool', 'Oyuncu havuzunu yükle', prep.pool],
        ] as const).map(([kind, title, complete], index) => <button key={kind} className={`setup-step ${complete ? 'complete' : ''}`} disabled={saving || kind === 'pool' && locked || kind !== 'league' && !prep.league} aria-describedby={kind !== 'league' && !prep.league ? 'league-required' : undefined} onClick={event => { if (kind === 'league' && !workspace) { opener.current = event.currentTarget; setImporting(true); } else openEditor(kind, event.currentTarget); }}>
          <span className="step-number">{index + 1}</span><strong>{title}</strong><span>{complete ? 'Tamamlandı · Düzenle' : 'Başlanmadı'}</span>
        </button>)}</div>
        {!prep.league && <p id="league-required" className="muted">Strateji ve oyuncu yükleme için önce ligini oluşturmalısın; takım ve sezon bilgileri gereklidir.</p>}
        {prep.league && !prep.strategy && <p className="muted">Stratejiyi tamamlamak için en az bir aktif kategori hedefi (İlk 1/3/5/7) belirle.</p>}
        {prep.hasDraft && <p role="status" className="notice">Hazırlık eksik. Mevcut draft seçimlerin ve takım sahipliği korunuyor; çalışma alanını kullanmaya devam edebilirsin. {!prep.pool && 'Aktif projeksiyon yok; analiz için yeni oyuncu verisi yükle.'}</p>}
      </section>}
      {workspace && !locked && <div hidden={editor !== 'pool'}>{centralSource ? <CentralDatasetPanel key={centralSource} initialSource={centralSource} /> : <PlayerImportPanel />}<button onClick={closeEditor}>Oyuncu verilerini kapat</button></div>}
      {workspace && editor === 'strategy' && <StrategyDialog targets={targets} onClose={closeEditor} onSuccess={() => {}} />}
      {locked && <p className="notice">Oyuncu havuzu bu çalışma için kilitli. Farklı Excel kullanmak için Yeni çalışma başlat.</p>}
      {workspace && (locked || prep.canOpen) && <DraftAssistant key={`draft-${workspace.league.id}`} onStrategy={() => setEditor('strategy')} />}
      <section aria-label="Acil kurtarma" hidden={!error && !conflict && load !== 'error'}><button onClick={() => setRecovery(v => !v)}>Acil JSON kurtarma</button>{recovery && <BackupPanel onRestored={closeEditor} />}</section>
      {reset && <DraftDialog title="Stratejiyi sıfırla" onClose={() => setReset(null)}>
        <p>Yalnızca kendi takımının dokuz hedefi Belirlenmedi (unset) olacak. Diğer stratejiler, projeksiyonlar ve draft seçimleri korunur.</p>
        <label className="check-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Bu sıfırlama işlemini açıkça onaylıyorum.</label>
        {reset.revision !== revision && <p role="alert">Çalışma alanı değişti. İşlemi yeniden açın.</p>}
        <div className="actions"><button disabled={!confirmed || saving || conflict || reset.revision !== revision} onClick={async () => {
          const ok = store.resetPreparation('strategy', confirmed, reset.revision);
          if (ok) { setReset(null); setEditor(null); }
        }}>Sıfırlamayı onayla</button><button onClick={() => setReset(null)}>İptal</button></div>
      </DraftDialog>}
    </>}
    </div>
  </>;
}
