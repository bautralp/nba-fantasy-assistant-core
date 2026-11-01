import type { Category } from './categories.ts';
import type { DatasetId } from './projection.ts';
import type { TeamId } from './team.ts';
import type { RosterSlot } from './roster.ts';

export type LeagueId = string;

export interface LeagueRules {
  readonly teamCount: number;
  readonly rosterSize: number;
  readonly draftFormat: 'snake';
  readonly categories: readonly Category[];
  readonly rosterSlots: readonly RosterSlot[];
}

export interface League {
  readonly id: LeagueId;
  readonly name: string;
  readonly season: string;
  readonly rules: LeagueRules;
  readonly activeDatasetId: DatasetId | null;
  readonly userTeamId: TeamId | null;
}
