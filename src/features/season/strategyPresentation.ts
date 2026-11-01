import type { Category, CategoryTarget } from '../../domain/models/categories.ts';
import type { CategoryImpact, CategoryStanding, TeamImpact } from '../../seasonAnalysis/teamInsights.ts';

/** Short Turkish explanations derived only from computed numbers. */
export const goalLabels: Record<CategoryTarget, string> = { unset: 'Belirlenmedi', top1: 'İlk 1', top3: 'İlk 3', top5: 'İlk 5', top7: 'İlk 7', punt: 'Punt' };
export const GOAL_OPTIONS: readonly CategoryTarget[] = ['top1', 'top3', 'top5', 'top7', 'punt', 'unset'];
const units: Record<Category, string> = { 'FG%': 'yüzde puanı', 'FT%': 'yüzde puanı', '3PM': 'üçlük', REB: 'ribaund', AST: 'asist', STL: 'top çalma', BLK: 'blok', TO: 'top kaybı', PTS: 'sayı' };
export const isPct = (c: Category) => c === 'FG%' || c === 'FT%';
const fmt = (n: number, digits: number) => n.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Projected team value: percentages with one decimal, counting totals as whole numbers. */
export const formatValue = (c: Category, n: number) => isPct(c) ? `${fmt(n, 1)}%` : fmt(n, 0);
export const formatAmount = (c: Category, n: number) => isPct(c) ? fmt(n, 1) : fmt(Math.ceil(n - 1e-9), 0);
export function formatDelta(c: Category, n: number) {
  const digits = isPct(c) ? 2 : 0, rounded = Number(n.toFixed(digits));
  if (rounded === 0) return isPct(c) ? '0,00 puan' : '0';
  return `${rounded > 0 ? '+' : '−'}${fmt(Math.abs(rounded), digits)}${isPct(c) ? ' puan' : ''}`;
}
const need = (c: Category, n: number) => c === 'TO' ? `${formatAmount(c, n)} daha az top kaybı` : `${formatAmount(c, n)} ${units[c]} daha`;

export function standingText(s: CategoryStanding): string {
  // The rank is displayed separately; sentences only add what the number does not say.
  if (s.status === 'punt') return 'Punt: öneri ağırlığı yok, değer hesapta kalır.';
  if (s.status === 'unset') return s.aboveGap !== null && s.rank > 1 ? `Bir üst sıra için ${need(s.category, s.aboveGap)} gerekiyor.` : s.rank === 1 ? 'Ligde zirvedesin.' : '';
  const goal = goalLabels[s.goal];
  if (s.status === 'missed') {
    const makes = s.makesNeeded !== null ? ` (aynı deneme hacminde yaklaşık ${fmt(Math.ceil(s.makesNeeded), 0)} isabet)` : '';
    return `${goal} hedefin için yaklaşık ${need(s.category, s.gap!)}${makes} gerekiyor.`;
  }
  if (s.cushion === null) return `Ligdeki takım sayısıyla ${goal} hedefi sağlanıyor.`;
  return s.cushion === 0 ? `${goal} hedefini eşitlikle tutuyorsun.` : `${goal} hedefini ${isPct(s.category) ? fmt(s.cushion, 1) : fmt(Math.round(s.cushion), 0)} ${units[s.category]} farkla koruyorsun.`;
}

/** Δz at or above this magnitude (league standard deviations) is worth a sentence. */
export const NOTABLE_DELTA_Z = 0.15;
export function impactSentences(impact: TeamImpact, shooting?: { FGM: number; FGA: number; FTM: number; FTA: number } | null, hasGoals = true): string[] {
  const weighted = impact.categories.filter(c => c.weight > 0);
  const plus = weighted.filter(c => c.deltaZ >= NOTABLE_DELTA_Z).sort((a, b) => b.weight * b.deltaZ - a.weight * a.deltaZ).slice(0, 3);
  const minus = weighted.filter(c => c.deltaZ <= -NOTABLE_DELTA_Z).sort((a, b) => a.weight * a.deltaZ - b.weight * b.deltaZ).slice(0, 2);
  const pct = (c: CategoryImpact) => {
    if (!shooting || !isPct(c.category)) return '';
    const [m, a] = c.category === 'FG%' ? [shooting.FGM, shooting.FGA] : [shooting.FTM, shooting.FTA];
    return a > 0 ? ` (maç başı ${fmt(a, 1)} deneme, %${fmt(100 * m / a, 1)})` : '';
  };
  const lines: string[] = [];
  const item = (c: CategoryImpact) => `${c.category} ${formatDelta(c.category, c.delta)}${c.category === 'TO' ? (c.delta > 0 ? ' (daha fazla top kaybı)' : ' (daha az top kaybı)') : ''}${pct(c)}`;
  const goalPlus = plus.filter(c => c.targeted), otherPlus = plus.filter(c => !c.targeted);
  if (goalPlus.length) lines.push(`Hedeflerini destekliyor: ${goalPlus.map(item).join(', ')}.`);
  if (otherPlus.length) lines.push(`${goalPlus.length || hasGoals ? 'Diğer katkı' : 'Katkı'}: ${otherPlus.map(item).join(', ')}.`);
  if (!plus.length) lines.push(hasGoals ? 'Ağırlık verdiğin kategorilerde belirgin katkısı yok.' : 'Belirgin kategori katkısı yok.');
  if (minus.length) lines.push(`Olumsuz etki: ${minus.map(item).join(', ')}.`);
  return lines;
}
export function rankChangeText(c: CategoryImpact): string {
  if (c.rankGain > 0) return `${c.beforeRank}. → ${c.afterRank}. (${c.rankGain} sıra yükseliş)`;
  if (c.rankGain < 0) return `${c.beforeRank}. → ${c.afterRank}. (${-c.rankGain} sıra düşüş)`;
  return `${c.afterRank}. (değişmedi)`;
}
export const formatScore = (n: number) => `${n > 0.005 ? '+' : n < -0.005 ? '−' : ''}${fmt(Math.abs(n), 2)}`;
