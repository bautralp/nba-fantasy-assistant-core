import type { Category } from '../../domain/models/categories.ts';
import type { TeamImpact } from '../../seasonAnalysis/teamInsights.ts';

/** Locative category names for rank-change sentences ("üçlükte 5. sıradan 3. sıraya"). */
export const categoryIn: Record<Category, string> = { 'FG%': 'FG%’de', 'FT%': 'FT%’de', '3PM': 'üçlükte', REB: 'ribaundda', AST: 'asistte', STL: 'top çalmada', BLK: 'blokta', TO: 'top kaybında', PTS: 'sayıda' };
/** Sentences only restate computed rank changes; punt categories are labelled, not hidden. */
export function addDropSummary(impact: TeamImpact, mine = true): string[] {
  const label = (c: TeamImpact['categories'][number]) => `${categoryIn[c.category]}${c.weight === 0 ? ' (punt)' : ''} ${c.beforeRank}. sıradan ${c.afterRank}. sıraya`;
  const up = impact.categories.filter(c => c.rankGain > 0), down = impact.categories.filter(c => c.rankGain < 0);
  const parts = [...(up.length ? [`${up.map(label).join(', ')} ${mine ? 'çıkıyorsun' : 'çıkıyor'}`] : []), ...(down.length ? [`${down.map(label).join(', ')} ${mine ? 'geriliyorsun' : 'geriliyor'}`] : [])];
  const lines = [parts.length ? `${mine ? 'Bu değişiklikle' : 'Bu takım'} ${parts.join('; ')}.` : 'Kategori sıraları değişmiyor.'];
  if (impact.goalsMetAfter !== impact.goalsMetBefore) lines.push(`Sağlanan hedef sayısı ${impact.goalsMetBefore} → ${impact.goalsMetAfter}.`);
  return lines;
}
