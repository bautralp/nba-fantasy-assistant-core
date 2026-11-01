import {
  NINE_CATEGORIES,
  type Category,
  type CategoryValues,
} from "../domain/models/categories.ts";
import type { ProjectionStats } from "../domain/models/projection.ts";
export interface Baselines {
  readonly fg: number;
  readonly ft: number;
}
export function categoryValues<T>(
  fn: (category: Category) => T,
): Record<Category, T> {
  return Object.fromEntries(NINE_CATEGORIES.map((c) => [c, fn(c)])) as Record<
    Category,
    T
  >;
}
export const average = (a: readonly number[]) =>
  a.reduce((x, y) => x + y, 0) / (a.length || 1);
export function deviation(a: readonly number[]): number {
  if (a.length < 2) return 1;
  const m = average(a);
  return (
    Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1)) || 1
  );
}
export function baseline(rows: readonly ProjectionStats[]): Baselines {
  const sum = (key: keyof ProjectionStats) =>
    rows.reduce((s, r) => s + r[key], 0);
  const fga = sum("FGA"),
    fta = sum("FTA");
  return {
    fg: fga ? sum("FGM") / fga : 0.47,
    ft: fta ? sum("FTM") / fta : 0.78,
  };
}
export function rawContributions(
  s: ProjectionStats,
  b: Baselines,
): CategoryValues<number> {
  return {
    "FG%": s.FGM - b.fg * s.FGA,
    "FT%": s.FTM - b.ft * s.FTA,
    "3PM": s["3PM"],
    PTS: s.PTS,
    REB: s.REB,
    AST: s.AST,
    STL: s.STL,
    BLK: s.BLK,
    TO: -s.TO,
  };
}
export function distribution(rows: readonly CategoryValues<number>[]) {
  return {
    means: categoryValues((c) => average(rows.map((r) => r[c]))),
    deviations: categoryValues((c) => deviation(rows.map((r) => r[c]))),
  };
}
