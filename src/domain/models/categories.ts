export const NINE_CATEGORIES = ['FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO'] as const;
export type Category = typeof NINE_CATEGORIES[number];
export type CategoryValues<T> = Readonly<Record<Category, T>>;

export const CATEGORY_TARGETS = ['unset', 'top1', 'top3', 'top5', 'top7', 'punt'] as const;
export type CategoryTarget = typeof CATEGORY_TARGETS[number];
export type CategoryTargets = CategoryValues<CategoryTarget>;

export function createUnsetTargets(): CategoryTargets {
  return { 'FG%': 'unset', 'FT%': 'unset', '3PM': 'unset', PTS: 'unset', REB: 'unset', AST: 'unset', STL: 'unset', BLK: 'unset', TO: 'unset' };
}
