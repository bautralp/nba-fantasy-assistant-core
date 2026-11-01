import { datasetUrl } from '../../publicCore/dataAccess.ts';
import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../app/WorkspaceContext';
import { loadScenarios } from '../../projections/loadScenarios.ts';
import { parseProjections } from '../rankings/rosProjection.ts';
import { applyCentralDataset, type CentralSource } from '../../application/centralDataset';
export function CentralDatasetPanel({ initialSource = 'projected' }: { initialSource?: CentralSource }) {
  const { workspace, store, revision, saving } = useWorkspace();
  const [source, setSource] = useState(initialSource);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const load = async () => {
    if (!workspace) return;
    const base = workspace, version = revision;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    setLoading(true); setError('');
    try {
      const fetchData = async (file: string) => {
        const response = await fetch(datasetUrl(import.meta.env.BASE_URL,file), { signal: controller.signal, cache: 'no-cache' });
        if (!response.ok) throw new Error('Merkezi kaynak alınamadı.');
        return response.json() as Promise<unknown>;
      };
      const [baseRaw, positions] = await Promise.all([fetchData(source === 'lastSeason' ? 'player-stats.json' : 'player-projections.json'), source === 'lastSeason' ? fetchData('player-projections.json') : Promise.resolve(null)]);
      const raw = source === 'extended' ? await loadScenarios(import.meta.env.BASE_URL, controller.signal, parseProjections(baseRaw)) : baseRaw;
      if (request.current !== controller || controller.signal.aborted) return;
      if (store.getSnapshot().revision !== version || store.getSnapshot().workspace !== base) throw new Error('Çalışma alanı değişti; kaynağı yeniden yükleyin.');
      const next = applyCentralDataset(base, source, raw, source === 'extended' ? baseRaw : positions, () => crypto.randomUUID(), new Date().toISOString());
      if (!store.accept(next)) throw new Error('Kaynak uygulanamadı; draft kilidini ve çalışma alanını kontrol edin.');
    } catch (e) { if (request.current === controller) setError(e instanceof Error ? e.message : 'Kaynak yüklenemedi.'); }
    finally { clearTimeout(timer); if (request.current === controller) setLoading(false); }
  };
  return <section aria-label="Merkezi draft kaynağı" className="panel">
    <h3>Merkezi oyuncu havuzu</h3>
    <label>Veri kaynağı<select aria-label="Veri kaynağı" value={source} disabled={loading} onChange={e => setSource(e.target.value as CentralSource)}>
      <option value="lastSeason">2025-26 Actual — Last Season</option><option value="projected">2026-27 Projected — ROS</option><option value="extended">2026-27 Genişletilmiş Tahmin — model senaryosu</option>
    </select></label>
    <p>{source === 'lastSeason' ? 'Gerçek 2025-26 maç başına üretim ve gözlenen sezon GP kullanılır. Lig sezonu 2026-27 kalır; bu bir ROS tahmini değildir.' : 'Tahmini maç başına üretim ve beklenen kalan normal sezon maç sayısı kullanılır. ROS GP sakatlıktan dönüş tarihi içermez.'}</p>
    {source === 'extended' && <p>Düşük güvenli rookie/returning veteran senaryoları içerir. MPG ve GP varsayımları bilimsel kabul değildir; sezon öncesinde tam sezon, sezon içinde kalan fikstür kullanılır. Kaynağı uygulamak mevcut hazırlık havuzunu açıkça değiştirir; başlamış draft kilitlidir.</p>}
    <p>Havuz hazırlandığında kaynak, oyuncu kimlikleri, pozisyonlar ve projeksiyonlar bu çalışma için sabitlenir. Doğrulanamayan ESPN pozisyonları boş kalır.</p>
    <button disabled={loading || saving} onClick={() => void load()}>{loading ? 'Kaynak yükleniyor…' : 'Merkezi kaynağı uygula'}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
