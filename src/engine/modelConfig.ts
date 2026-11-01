import {
  INITIAL_LEAGUE_RULES,
  totalDraftPicks,
} from "../domain/rules/leagueRules.ts";
export const RULES = INITIAL_LEAGUE_RULES;
export const CAPACITY = RULES.rosterSize;
export const MAX_PICKS = totalDraftPicks(RULES);
export const TARGET_PACE = {
  top1: 0.72,
  top3: 0.43,
  top5: 0.19,
  top7: -0.04,
} as const;
export const TARGET_TIER = {
  top1: 1.12,
  top3: 1.07,
  top5: 1.03,
  top7: 0.91,
} as const;
export type ActiveTarget = keyof typeof TARGET_PACE;
export const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
