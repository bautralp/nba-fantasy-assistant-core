import type { CategoryTarget } from '../../domain/models/categories.ts';
import { CATEGORIES } from '../../seasonAnalysis/model.ts';
import type { SeasonCategoryGoals } from '../../seasonAnalysis/strategy.ts';
import { GOAL_OPTIONS, goalLabels } from './strategyPresentation.ts';

export const strategySummary = (goals: SeasonCategoryGoals) => {
  const set = CATEGORIES.filter(c => goals[c] !== 'unset');
  return set.length ? set.map(c => `${c} ${goalLabels[goals[c]]}`).join(' · ') : 'Hedef belirlenmedi';
};
/** Compact editor for the shared in-season goals (same store as Team Analysis). */
export function StrategyEditor({ goals, onChange, onClear }: { goals: SeasonCategoryGoals; onChange: (c: typeof CATEGORIES[number], g: CategoryTarget) => void; onClear: () => void }) {
  return <details className="season-strategy-editor">
    <summary>Stratejin: <strong>{strategySummary(goals)}</strong></summary>
    <p className="muted">Takım Analizi ile aynı hedefler. Punt kategorisi öneri puanına katılmaz; değeri hesapta kalır.</p>
    <div className="season-strategy-grid">{CATEGORIES.map(c => <label key={c}>{c}
      <select aria-label={`${c} hedefi`} value={goals[c]} onChange={e => onChange(c, e.target.value as CategoryTarget)}>{GOAL_OPTIONS.map(g => <option key={g} value={g}>{goalLabels[g]}</option>)}</select>
    </label>)}</div>
    {CATEGORIES.some(c => goals[c] !== 'unset') && <button type="button" onClick={onClear}>Hedefleri temizle</button>}
  </details>;
}
