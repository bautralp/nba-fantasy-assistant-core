import { CATEGORY_TARGETS, type Category, type CategoryTarget } from '../domain/models/categories.ts';
import { CATEGORIES } from './model.ts';

/** In-season goals. Same target vocabulary as Draft, separate state and storage. */
export type SeasonCategoryGoals = Readonly<Record<Category, CategoryTarget>>;
export const SEASON_STRATEGY_SCHEMA = 1;
export const seasonStrategyKey = (leagueId: number, seasonId: number, teamId: number) =>
  `nba-fantasy-assistant.season-strategy.v1:${leagueId}:${seasonId}:${teamId}`;
export const unsetGoals = (): SeasonCategoryGoals =>
  Object.fromEntries(CATEGORIES.map(c => [c, 'unset'])) as unknown as SeasonCategoryGoals;
export const GOAL_RANK: Partial<Record<CategoryTarget, number>> = { top1: 1, top3: 3, top5: 5, top7: 7 };

export function parseSeasonGoals(value: unknown): SeasonCategoryGoals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== SEASON_STRATEGY_SCHEMA || !v.goals || typeof v.goals !== 'object') return null;
  const goals = v.goals as Record<string, unknown>;
  if (Object.keys(goals).length !== CATEGORIES.length) return null;
  for (const c of CATEGORIES) if (!(CATEGORY_TARGETS as readonly unknown[]).includes(goals[c])) return null;
  return Object.fromEntries(CATEGORIES.map(c => [c, goals[c]])) as unknown as SeasonCategoryGoals;
}

export interface StrategyStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
/** Missing or invalid stored goals become "unset"; they are never guessed. */
export function readSeasonGoals(storage: StrategyStorage, key: string): { goals: SeasonCategoryGoals; error: string | null } {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { goals: unsetGoals(), error: null };
    const goals = parseSeasonGoals(JSON.parse(raw));
    return goals ? { goals, error: null } : { goals: unsetGoals(), error: 'Kayıtlı strateji okunamadı; hedefler Belirlenmedi olarak açıldı.' };
  } catch { return { goals: unsetGoals(), error: 'Kayıtlı strateji okunamadı; hedefler Belirlenmedi olarak açıldı.' }; }
}
export function writeSeasonGoals(storage: StrategyStorage, key: string, goals: SeasonCategoryGoals): string | null {
  try { storage.setItem(key, JSON.stringify({ schemaVersion: SEASON_STRATEGY_SCHEMA, goals })); return null; }
  catch { return 'Strateji bu tarayıcıda kaydedilemedi; bu ekranda geçerli kalır.'; }
}
