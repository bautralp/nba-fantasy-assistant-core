import type { LeaguePlayer, PublicLeague } from './model.ts';
export const isCategoryScoring = (type: string) => type === 'H2H_MOST_CATEGORIES' || type === 'H2H_EACH_CATEGORY';
/** Preserve ESPN scoringItems, including explicit unknown stat labels; never add default categories. */
export const matchupCategories = (league: PublicLeague) => isCategoryScoring(league.scoring.type) ? league.scoring.categories : [];
const higherIsBetter = new Set([0, 1, 2, 3, 6, 13, 14, 15, 16, 17, 19, 20, 21]);
export const categoryIsReverse = (id: number, providerReverse: boolean | null = null) => id === 11 ? true : providerReverse ?? (higherIsBetter.has(id) ? false : null);
export const scheduleWeeks = (league: PublicLeague) => [...new Set(league.matchups?.map(m => m.matchupPeriodId) ?? [])].sort((a, b) => a - b);
export function categoryValue(value: number | undefined, id: number) {
  if (value === undefined) return 'Mevcut değil';
  return id === 19 || id === 20 || id === 21 ? `${(value * 100).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%` : value.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
}
export function categoryLeader(home: number | undefined, away: number | undefined, id: number, providerReverse: boolean | null = null): 'home' | 'away' | 'tie' | null {
  if (home === undefined || away === undefined) return null;
  if (home === away) return 'tie';
  const reverse = categoryIsReverse(id, providerReverse);
  if (reverse === null) return null;
  return (reverse ? home < away : home > away) ? 'home' : 'away';
}
/** Normalized specific basketball positions, independent of fantasy lineup slot labels. */
export function eligiblePositions(player: LeaguePlayer) {
  return player.displayPositions.length ? player.displayPositions.join(' · ') : 'Pozisyon bilinmiyor';
}
