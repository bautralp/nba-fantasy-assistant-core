import { NINE_CATEGORIES, type Category, type CategoryValues } from '../../domain/models/categories.ts';
import type { StatsPlayer } from './centralStats.ts';
import { playerZScores } from './playerZScores.ts';
import type { ROSSnapshot } from './rosProjection.ts';

/** Rankings-screen importance multipliers. 0 means the category is punted. */
export const WEIGHT_OPTIONS = [0, 0.25, 0.5, 1, 1.5, 2, 3] as const;
export type CategoryWeight = typeof WEIGHT_OPTIONS[number];
export type CategoryWeights = CategoryValues<CategoryWeight>;
export const DEFAULT_WEIGHTS: CategoryWeights = Object.freeze(Object.fromEntries(NINE_CATEGORIES.map(c => [c, 1])) as Record<Category, CategoryWeight>);
export const WEIGHTS_SESSION_KEY = 'nba-fantasy-assistant.rankings-weights.v1';

export const isWeight = (value: unknown): value is CategoryWeight => (WEIGHT_OPTIONS as readonly unknown[]).includes(value);
export const isDefaultWeights = (weights: CategoryWeights) => NINE_CATEGORIES.every(c => weights[c] === 1);
export const formatWeight = (weight: CategoryWeight) => weight === 0 ? '0 (punt)' : String(weight).replace('.', ',');

/** Invalid or partial stored values fall back to the defaults as a whole. */
export function parseWeights(value: unknown): CategoryWeights {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_WEIGHTS;
  const record = value as Record<string, unknown>;
  return NINE_CATEGORIES.every(c => isWeight(record[c])) ? Object.freeze(Object.fromEntries(NINE_CATEGORIES.map(c => [c, record[c]]))) as CategoryWeights : DEFAULT_WEIGHTS;
}
export function loadWeights(storage: Pick<Storage, 'getItem'> | null = globalThis.sessionStorage ?? null): CategoryWeights {
  try { return parseWeights(JSON.parse(storage?.getItem(WEIGHTS_SESSION_KEY) ?? 'null')); } catch { return DEFAULT_WEIGHTS; }
}
/** Returns false when the browser refuses session storage; the in-memory choice still applies. */
export function saveWeights(weights: CategoryWeights, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = globalThis.sessionStorage ?? null): boolean {
  try {
    if (isDefaultWeights(weights)) storage?.removeItem(WEIGHTS_SESSION_KEY); else storage?.setItem(WEIGHTS_SESSION_KEY, JSON.stringify(weights));
    return !!storage;
  } catch { return false; }
}

interface Scored { readonly id: string; readonly z: CategoryValues<number> }
/**
 * Weighted total of the unchanged category z-scores, re-ranked with the same
 * order and tie rule as playerZScores (total descending, then id). With every
 * weight at 1 each term is multiplied by exactly 1, so totals and ranks are identical.
 */
export function applyWeights<T extends Scored>(players: readonly T[], weights: CategoryWeights): (T & { totalZ: number; rank: number })[] {
  return players.map(p => ({ ...p, totalZ: NINE_CATEGORIES.reduce((sum, c) => sum + p.z[c] * weights[c], 0) }))
    .sort((a, b) => b.totalZ - a.totalZ || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p, index) => ({ ...p, rank: index + 1 }));
}

/** Same inputs the published ROS ranking uses (scripts/rank_projections.ts → rankProjections). */
export function rosZScores(snapshot: ROSSnapshot) {
  const inputs: StatsPlayer[] = snapshot.players.filter(p => p.status === 'available').map(p => ({
    id: p.id, name: p.name, team: p.team, position: p.positions.join('/'), gp: p.rosGP ?? 0,
    stats: p.stats!, totals: p.stats!,
  }));
  return playerZScores(inputs).players;
}
