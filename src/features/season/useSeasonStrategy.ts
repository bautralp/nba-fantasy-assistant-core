import { useCallback, useSyncExternalStore } from 'react';
import type { Category, CategoryTarget } from '../../domain/models/categories.ts';
import { readSeasonGoals, seasonStrategyKey, unsetGoals, writeSeasonGoals, type SeasonCategoryGoals } from '../../seasonAnalysis/strategy.ts';

/** In-season goals shared by Team Analysis and Waiver. Draft targets are a separate store. */
const memory = new Map<string, { goals: SeasonCategoryGoals; error: string | null }>();
const listeners = new Set<() => void>();
const storage = () => { try { return sessionStorage; } catch { return null; } };
function current(key: string) {
  let entry = memory.get(key);
  if (!entry) {
    const s = storage();
    entry = s ? readSeasonGoals(s, key) : { goals: unsetGoals(), error: 'Strateji bu tarayıcıda kaydedilemedi; bu ekranda geçerli kalır.' };
    memory.set(key, entry);
  }
  return entry;
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useSeasonStrategy(leagueId: number, seasonId: number, teamId: number) {
  const key = seasonStrategyKey(leagueId, seasonId, teamId);
  const entry = useSyncExternalStore(subscribe, () => current(key));
  const save = useCallback((goals: SeasonCategoryGoals) => {
    const s = storage();
    const error = s ? writeSeasonGoals(s, key, goals) : 'Strateji bu tarayıcıda kaydedilemedi; bu ekranda geçerli kalır.';
    memory.set(key, { goals, error });
    for (const l of listeners) l();
  }, [key]);
  const setGoal = useCallback((category: Category, target: CategoryTarget) => save({ ...current(key).goals, [category]: target }), [key, save]);
  const clear = useCallback(() => save(unsetGoals()), [save]);
  return { goals: entry.goals, error: entry.error, setGoal, clear };
}
