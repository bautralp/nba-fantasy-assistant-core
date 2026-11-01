import type { MatchupSide } from './model.ts';

const unavailable = 'Mevcut değil';
const display = (value: number | null) => value === null ? unavailable : String(value);

/** Presentation only: never calculate scores or infer a format from totalPoints. */
export function matchupScorePresentation(scoringType: string, side: MatchupSide | null) {
  if (scoringType === 'H2H_MOST_CATEGORIES' || scoringType === 'H2H_EACH_CATEGORY') {
    const record = side?.categoryRecord;
    const values = record ? [record.wins, record.losses, record.ties] : [];
    return { label: 'Kategori W/L/T', value: values.some(value => value !== null) ? values.map(display).join(' / ') : unavailable };
  }
  // Explicit FBA points format allowlist; unknown/roto formats must not expose a misleading weekly score.
  if (scoringType === 'H2H_POINTS') return { label: 'Haftalık puan', value: display(side?.score ?? null) };
  return { label: 'Haftalık skor', value: unavailable };
}
