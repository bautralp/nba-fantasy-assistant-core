import { NINE_CATEGORIES } from '../../domain/models/categories';
import { WEIGHT_OPTIONS, formatWeight, isDefaultWeights, isWeight, DEFAULT_WEIGHTS, type CategoryWeights } from './categoryWeights';
import './categoryWeights.css';

export const weightsSummary = (weights: CategoryWeights) => isDefaultWeights(weights) ? 'Tümü 1 (varsayılan)'
  : NINE_CATEGORIES.filter(c => weights[c] !== 1).map(c => `${c} ×${formatWeight(weights[c]).replace(' (punt)', '')}`).join(' · ');

/** Compact, collapsed by default so the table stays near the top on phones. */
export function CategoryWeightsPanel({ weights, onChange, notice }: { weights: CategoryWeights; onChange: (next: CategoryWeights) => void; notice?: string }) {
  const changed = !isDefaultWeights(weights);
  return <details className="category-weights">
    <summary><span className="category-weights-title">Kategori katsayıları</span><span className="category-weights-summary">{weightsSummary(weights)}</span><span className="category-weights-toggle" aria-hidden="true">▾</span></summary>
    <div className="category-weights-body">
      <p className="muted">Toplam skor, her kategorinin z-skoru seçilen katsayıyla çarpılarak toplanır. 0 kategoriyi punt eder. Z-skorları ve Draft hesapları değişmez.</p>
      <div className="category-weights-grid">{NINE_CATEGORIES.map(c => <label key={c}>{c}<select aria-label={`${c} katsayısı`} value={String(weights[c])} onChange={e => {
        const value = Number(e.target.value);
        if (isWeight(value)) onChange(Object.freeze({ ...weights, [c]: value }));
      }}>{WEIGHT_OPTIONS.map(w => <option key={w} value={String(w)}>{formatWeight(w)}</option>)}</select></label>)}</div>
      <button type="button" disabled={!changed} onClick={() => onChange(DEFAULT_WEIGHTS)}>Sıfırla</button>
      {notice && <p role="status" className="muted">{notice}</p>}
    </div>
  </details>;
}
