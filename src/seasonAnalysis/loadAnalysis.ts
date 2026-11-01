import { datasetUrl, isSyntheticDemo } from '../publicCore/dataAccess.ts';
import { adaptCentralRos, parseAnalysisSchedule } from './centralAdapter.ts';
/** Bounded, cancellable static reads. Partial or stale pairs never become a successful analysis. */
export async function loadAnalysisSources(base: string, signal: AbortSignal) {
  async function read(path: string, maxBytes: number) {
    const response = await fetch(datasetUrl(base,path), { signal, cache: 'no-cache', credentials: 'omit' });
    if (!response.ok) throw new Error(`${path} alınamadı (HTTP ${response.status}).`);
    if (!response.body || Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Analiz veri boyutu sınırı aşıldı.'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) throw new Error('Analiz veri boyutu sınırı aşıldı.'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  const [raw, rawSchedule] = await Promise.all([read('player-projections.json', 8 * 1024 * 1024), read('analysis-schedule.json', 512 * 1024)]);
  const schedule = parseAnalysisSchedule(rawSchedule,{allowSynthetic:isSyntheticDemo()});
  return { ...adaptCentralRos(raw, schedule), schedule };
}
