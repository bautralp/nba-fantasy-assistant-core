import { NINE_CATEGORIES, type CategoryTargets } from '../../domain/models/categories.ts';

/** UI starting point only: a team with no targets yet sees İlk 5 everywhere. Nothing is stored until applied. */
export const UI_DEFAULT_TARGET = 'top5' as const;
export function initialDialogTargets(targets: CategoryTargets): { values: CategoryTargets; suggested: boolean } {
  const suggested = NINE_CATEGORIES.every(c => targets[c] === 'unset');
  return { values: suggested ? Object.fromEntries(NINE_CATEGORIES.map(c => [c, UI_DEFAULT_TARGET])) as unknown as CategoryTargets : { ...targets }, suggested };
}
