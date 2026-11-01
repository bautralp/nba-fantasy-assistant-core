import { NINE_CATEGORIES } from '../models/categories.ts';
import type { LeagueRules } from '../models/league.ts';

export const INITIAL_LEAGUE_RULES: LeagueRules = Object.freeze({
  teamCount: 10,
  rosterSize: 13,
  draftFormat: 'snake',
  categories: Object.freeze([...NINE_CATEGORIES]),
  rosterSlots: Object.freeze(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'UTIL', 'UTIL', 'BENCH', 'BENCH', 'BENCH'] as const),
});

export function totalDraftPicks(rules: LeagueRules): number {
  return rules.teamCount * rules.rosterSize;
}

/** Broader model shapes are reserved for future versions, not enabled settings. */
export function isSupportedLeagueRules(rules: LeagueRules): boolean {
  const initial = INITIAL_LEAGUE_RULES;
  return rules.teamCount === initial.teamCount && rules.rosterSize === initial.rosterSize
    && rules.draftFormat === initial.draftFormat
    && rules.categories.length === initial.categories.length
    && rules.categories.every((category, index) => category === initial.categories[index])
    && rules.rosterSlots.length === initial.rosterSlots.length
    && rules.rosterSlots.every((slot, index) => slot === initial.rosterSlots[index]);
}
