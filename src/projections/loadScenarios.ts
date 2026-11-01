import { datasetUrl } from '../publicCore/dataAccess.ts';
import { parseScenarioSnapshot, type ScenarioSnapshot } from './scenarioSnapshot.ts';
import type { ROSSnapshot } from '../features/rankings/rosProjection.ts';
export async function loadScenarios(base: string, signal: AbortSignal, standard: ROSSnapshot): Promise<ScenarioSnapshot> {
  const response = await fetch(datasetUrl(base,'projection-scenarios.json'), {signal, cache:'no-cache', credentials:'omit'});
  if (!response.ok) throw new Error(`Genişletilmiş tahmin alınamadı (HTTP ${response.status}).`);
  const limit = 12 * 1024 * 1024;
  if (!response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Senaryo veri boyutu sınırı aşıldı.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw new Error('Senaryo veri boyutu sınırı aşıldı.'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) {bytes.set(c,offset);offset+=c.length;}
  const snapshot = parseScenarioSnapshot(JSON.parse(new TextDecoder().decode(bytes)), standard);
  if (snapshot.modelVersion !== 'unified-ros/2') throw new Error('Kalan sezon tahmininin yeni sürümü henüz yayımlanmadı.');
  return snapshot;
}
