import type { AnalysisView } from '../../application/analysisSelectors';
import type { DraftView } from '../../application/draftSelectors';
import { metric, targetLabels } from './analysisFormatting';
export function OpponentAnalysisPanel({ analysis, view }: { analysis: AnalysisView; view: DraftView }) {
  return <details open className="opponent-analysis"><summary><h3>Rakip analizi</h3></summary>
    <p className="muted">Fark = rakip puanı − takımınızın puanı. Pozitif farkta rakip öndedir; sıfır eşit puandır. Güven etiketleri mevcut projeksiyon kapsamına dayanır, kesin tahmin değildir.</p>
    {analysis.opponentEmpty ? <p className="notice">{analysis.opponentEmpty}</p> : <div className="analysis-scroll opponent-scroll" tabIndex={0} role="region" aria-label="Rakip analiz tablosu"><table className="analysis-table"><thead><tr>{['Kategori', 'Rakip takım', 'Hedef seviye', 'Puan farkı', 'Rakibin durumu', 'Geçerli oyuncu', 'Güven'].map(h => <th scope="col" key={h}>{h}</th>)}</tr></thead><tbody>{view.opponents.map(o => <tr key={`${o.cat}-${o.teamId}`}><th scope="row">{o.cat}</th><td>{o.team}</td><td>{targetLabels[o.level]}</td><td>{o.gap > 0 ? '+' : ''}{metric(o.gap)}</td><td>{o.ahead ? 'Rakip önde' : o.gap === 0 ? 'Eşit puan' : 'Rakip geride · yakın takipte'}</td><td>{o.rated}</td><td>{o.confidence}</td></tr>)}</tbody></table></div>}
  </details>;
}
