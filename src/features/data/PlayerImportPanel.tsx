import { useRef, useState } from 'react';
import { useWorkspace } from '../../app/WorkspaceContext';
import { prepareManualImport, applyManualImport } from '../../application/manualImport';
import type { ImportPreview } from '../../application/importPlayers';
import type { RawFile } from '../../application/projectionRows';
import { readProjectionFile, downloadWorkbook } from '../../infrastructure/projections/readFile';
import { createWorkbook } from '../../infrastructure/projections/workbook';

export function PlayerImportPanel() {
  const { workspace, revision, saving, store } = useWorkspace();
  const [raw, setRaw] = useState<RawFile | null>(null), [preview, setPreview] = useState<ImportPreview | null>(null);
  const [season, setSeason] = useState(''), [unit, setUnit] = useState('');
  const [message, setMessage] = useState(''), [reading, setReading] = useState(false);
  const generation = useRef(0), input = useRef<HTMLInputElement>(null);
  if (!workspace || workspace.manualDraftLocked) return null;
  const build = (file: RawFile, selectedSeason = season, selectedUnit = unit) => {
    const current = store.getSnapshot(); if (!current.workspace) return;
    try {
      setPreview(prepareManualImport(file, { ...(selectedSeason ? { season: selectedSeason } : {}), ...(selectedUnit ? { unit: selectedUnit } : {}) }, current.workspace, current.revision, () => crypto.randomUUID(), new Date().toISOString()));
      setMessage('Önizlemeyi inceleyin; henüz uygulanmadı.');
    } catch (e) { setPreview(null); setMessage(e instanceof Error ? e.message : 'Dosya okunamadı.'); }
  };
  const cancel = () => { generation.current++; setReading(false); setRaw(null); setPreview(null); setMessage(''); if (input.current) input.current.value = ''; };
  const choose = async (file?: File) => {
    cancel(); const token = generation.current; setSeason(''); setUnit(''); if (!file) return; setReading(true);
    try { const result = await readProjectionFile(file); if (token !== generation.current) return; setRaw(result); if (result.season && result.unit) build(result, '', ''); else setMessage('Dosyada tanımlanmamış sezon ve veri birimini açıkça belirtip önizleyin.'); }
    catch (e) { if (token === generation.current) setMessage(e instanceof Error ? e.message : 'Dosya okunamadı.'); }
    finally { if (token === generation.current) setReading(false); }
  };
  return <section className="panel import-review" aria-labelledby="player-data-heading">
    <h2 id="player-data-heading">Oyuncu verileri</h2>
    <p>Excel/CSV/JSON yükle. Oyuncu kimlikleri bu çalışma için otomatik oluşturulur. Dosya seçimi mevcut verileri değiştirmez.</p>
    <button onClick={() => downloadWorkbook(createWorkbook(workspace.league.season, 'perGame'), 'nba-fantasy-projections.xlsx')}>Boş Excel şablonunu indir</button>
    <label className="file-label">Oyuncu projeksiyonu dosyası<input ref={input} type="file" accept=".xlsx,.csv,.json" onChange={e => void choose(e.target.files?.[0])} /></label>
    {reading && <p role="status">Dosya okunuyor…</p>}
    {raw && <><p>Seçilen projeksiyon dosyası: {raw.name}</p><div className="form-grid">
      <label>Projeksiyon sezonu<input value={typeof raw.season === 'string' ? raw.season : season} disabled={raw.season !== undefined} onChange={e => { setSeason(e.target.value); setPreview(null); }} /></label>
      <label>Projeksiyon veri birimi<select aria-label="Projeksiyon veri birimi" value={typeof raw.unit === 'string' ? raw.unit : unit} disabled={raw.unit !== undefined} onChange={e => { setUnit(e.target.value); setPreview(null); }}><option value="">Açıkça seçin</option><option value="perGame">perGame · Maç başına</option><option value="totals">totals · Sezon toplamı</option></select></label>
    </div><button disabled={reading || saving} onClick={() => build(raw)}>Projeksiyonları önizle</button></>}
    {preview && <><h3>Projeksiyon önizlemesi</h3><p>{preview.file.name} · {preview.file.season} · {preview.file.unit} · {preview.rows.length} oyuncu</p>
      {!preview.rows.some(r => !r.data.issues.some(i => i.level === 'row')) && <p className="notice">Tüm projeksiyonlar analiz dışı.</p>}
      <ul>{[...preview.file.issues, ...preview.rows.flatMap(r => r.data.issues)].map((i, n) => <li key={n}>{i.level === 'warning' ? 'Uyarı' : 'Analiz dışı'} · Satır {i.row} · {i.field}: {i.message}</li>)}</ul>
      {preview.revision !== revision && <p role="alert">Çalışma alanı değişti. Dosyayı yeniden önizleyin.</p>}
      <button className="primary" disabled={saving || revision !== preview.revision} onClick={() => {
        const current = store.getSnapshot(); if (!current.workspace) return;
        try { if (store.accept(applyManualImport(preview, current.workspace, current.revision))) { cancel(); setMessage('Oyuncu verileri uygulandı.'); } }
        catch (e) { setMessage(e instanceof Error ? e.message : 'İşlem uygulanamadı.'); }
      }}>Yüklemeyi uygula</button></>}
    {message && <p role="status">{message}</p>}<button onClick={cancel}>Yüklemeyi iptal et</button>
  </section>;
}
