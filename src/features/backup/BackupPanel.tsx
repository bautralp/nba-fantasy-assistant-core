import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../app/WorkspaceContext';
import { newIdentity } from '../../application/leagueSetup';
import { describeError, describeNotice } from '../../application/errorMessages';
import type { WorkspaceSnapshot } from '../../domain/models/workspace';
import { downloadWorkspace } from '../../infrastructure/persistence/downloadWorkspace';
import { migrateLegacyV3Json, type LegacyV3Options, type MigrationNotice } from '../../infrastructure/persistence/legacyV3';
import { isRecord, parseJson, restoreWorkspaceJson } from '../../infrastructure/persistence/workspaceJson';

interface SelectedBackup { text: string; name: string; legacy: boolean; leagueId: string; importedAt: string }
interface Preview { snapshot: WorkspaceSnapshot; notices: readonly MigrationNotice[]; revision: number }
export function BackupPanel({ onRestored }: { onRestored: () => void }) {
  const { workspace, revision, store, saving } = useWorkspace();
  const [selected, setSelected] = useState<SelectedBackup | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState('');
  const [season, setSeason] = useState('');
  const [message, setMessage] = useState('');
  const [turnIssues, setTurnIssues] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [replace, setReplace] = useState(false);
  const [reading, setReading] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const resetPreview = () => { setPreview(null); setReplace(false); setTurnIssues([]); setConsent(false); setMessage(''); };
  const choose = async (file: File | undefined) => {
    const token = ++request.current;
    resetPreview(); setSelected(null); setName(''); setSeason('');
    if (!file) { setReading(false); return; }
    setReading(true);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Dosya 20 MB sınırını aşıyor.');
      const text = await file.text();
      if (token !== request.current) return;
      const parsed = parseJson(text);
      if (!parsed.ok) { setMessage(describeError(parsed.error)); return; }
      const legacy = isRecord(parsed.value) && parsed.value.version === 3;
      setSelected({ text, name: file.name, legacy, leagueId: newIdentity(), importedAt: new Date().toISOString() });
      setMessage(legacy ? 'v3 yedeği seçildi. Lig adını ve sezonu girip önizleyin.' : 'Yedek seçildi. Doğrulamak için önizleyin.');
    } catch (error) { if (token === request.current) setMessage(`${error instanceof Error ? error.message : 'Dosya okunamadı.'} Mevcut çalışma alanı korundu.`); }
    finally { if (token === request.current) setReading(false); }
  };
  const inspect = (confirmed = false) => {
    if (!selected) return;
    setPreview(null); setReplace(false); setMessage('');
    if (selected.legacy) {
      if (!name.trim() || !season.trim()) { setMessage('v3 aktarımı için lig adı ve sezon gerekli.'); return; }
      const options: LegacyV3Options = { leagueId: selected.leagueId, season: season.trim(), importedAt: selected.importedAt, confirmUnverifiableTurns: confirmed };
      const result = migrateLegacyV3Json(selected.text, options);
      if (!result.ok) {
        setMessage(describeError(result.error));
        if (result.error.code === 'legacy-migration') {
          const parsed = JSON.parse(selected.text);
          setTurnIssues(result.error.issues.filter(issue => issue.code === 'legacy-turn-confirmation-required').map(issue => {
            const index = Number(issue.path.match(/\[(\d+)\]/)?.[1]);
            const pick = parsed.picks[index];
            const player = parsed.players.find((item: { id: string }) => item.id === pick.id);
            return `Seçim ${index + 1}: ${player?.name ?? pick.id} → ${parsed.teams[pick.team]} (${issue.path})`;
          }));
        }
        return;
      }
      setTurnIssues([]);
      setPreview({ snapshot: { ...result.value.snapshot, league: { ...result.value.snapshot.league, name: name.trim() } }, notices: result.value.notices, revision });
    } else {
      const result = restoreWorkspaceJson(selected.text);
      if (!result.ok) { setMessage(describeError(result.error)); return; }
      setPreview({ snapshot: result.value, notices: [], revision });
    }
  };
  const restore = () => {
    if (!preview || (workspace && !replace)) return;
    if (store.getSnapshot().revision !== preview.revision) { resetPreview(); setMessage('Çalışma alanı değişti. Yedeği yeniden önizleyip onaylayın.'); return; }
    if (store.accept(preview.snapshot, true)) {
      setPreview(null); setSelected(null); setMessage('Yedek çalışma alanına geri yüklendi. Oturum kayıt durumunu kontrol edin.'); onRestored();
    }
  };
  return <section className="panel" aria-labelledby="backup-heading">
    <h2 id="backup-heading">JSON yedekleme ve geri yükleme</h2>
    <p className="muted">Netlify oturumunuz yeni adrese otomatik taşınmaz. Eski adreste JSON yedeğini indirin; yeni adreste bu panelden dosyayı seçip önizleyin ve geri yüklemeyi onaylayın. Yedekleri cihazlar arasında taşıyabilirsiniz. Onaylanan geri yükleme bu sekmenin oturumuna otomatik kaydedilir.</p>
    {workspace && <button type="button" onClick={() => setMessage(downloadWorkspace(workspace) ?? 'JSON yedeği indirme işlemi başlatıldı.')}>JSON yedeğini indir</button>}
    <label className="file-label">JSON yedeği seç<input type="file" accept=".json,application/json" disabled={saving} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ''; }} /></label>
    {reading && <p role="status">Dosya okunuyor…</p>}
    {selected && <div>
      <p>Seçilen dosya: {selected.name}</p>
      {selected.legacy && <div className="form-grid">
        <label>Aktarılan lig adı<input value={name} onChange={event => { setName(event.target.value); resetPreview(); }} /></label>
        <label>Aktarılan sezon<input value={season} placeholder="Örn. 2026-27" onChange={event => { setSeason(event.target.value); resetPreview(); }} /></label>
        <p className="muted">Eski yükleme tarihi bilinmiyor. Aktarım zamanı: {new Date(selected.importedAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })} (İstanbul). Bu tarih eski veri yükleme tarihi değildir.</p>
      </div>}
      <button type="button" disabled={saving || reading} onClick={() => { setConsent(false); setTurnIssues([]); inspect(); }}>Yedeği önizle</button>
    </div>}
    {turnIssues.length > 0 && <div className="import-review">
      <h3>Doğrulanamayan seçimler</h3><ul>{turnIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>
      <label className="check-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Bu seçimlerin mevcut sahipliğini korumayı açıkça onaylıyorum.</label>
      <button type="button" disabled={!consent || saving} onClick={() => inspect(true)}>Onayla ve aktarımı yeniden doğrula</button>
    </div>}
    {preview && <div className="import-review">
      <h3>Geri yükleme önizlemesi</h3><p>{preview.snapshot.league.name || 'İsimsiz lig'} · {preview.snapshot.league.season} · {preview.snapshot.teams.length} takım · {preview.snapshot.players.length} oyuncu · {preview.snapshot.draftSession?.picks.length ?? 0} seçim</p>
      {preview.notices.length > 0 && <><h3>Aktarım bildirimleri ve sınırlar</h3><ul>{preview.notices.map((notice, index) => <li key={index}>{describeNotice(notice)}</li>)}</ul></>}
      {workspace && <label className="check-label"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />Mevcut çalışma alanının ve kaydedilmemiş değişikliklerin bu yedekle değiştirilmesini onaylıyorum.</label>}
      <div className="actions"><button type="button" disabled={saving || (!!workspace && !replace)} onClick={restore}>Yedeği geri yükle</button><button type="button" onClick={() => { resetPreview(); setSelected(null); }}>Aktarımdan vazgeç</button></div>
    </div>}
    <p role="status" className="operation-message">{message}</p>
  </section>;
}
