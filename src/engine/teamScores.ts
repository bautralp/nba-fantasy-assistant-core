import type { Team, TeamId } from "../domain/models/team.ts";
import type { RosterEntry } from "../domain/models/roster.ts";
import type { PlayerId } from "../domain/models/player.ts";
import {
  NINE_CATEGORIES,
  type CategoryValues,
} from "../domain/models/categories.ts";
import type { CalculationModel } from "./model.ts";
import { categoryValues } from "./categoryScores.ts";
import { CAPACITY } from "./modelConfig.ts";
export interface TeamScore {
  readonly teamId: TeamId;
  readonly name: string;
  count: number;
  rated: number;
  sum: Record<keyof CategoryValues<number>, number>;
  score: Record<keyof CategoryValues<number>, number | null>;
}
export function teamScores(
  teams: readonly Team[],
  roster: readonly RosterEntry[],
  model: CalculationModel,
  extra?: { teamId: TeamId; playerId: PlayerId },
): TeamScore[] {
  const totals = teams.map((t) => ({
    teamId: t.id,
    name: t.name,
    count: 0,
    rated: 0,
    sum: categoryValues(() => 0),
    score: categoryValues<number | null>(() => null),
  }));
  const byId = new Map(totals.map((t) => [t.teamId, t]));
  for (const pick of [...roster, ...(extra ? [extra] : [])]) {
    const t = byId.get(pick.teamId);
    if (!t) continue;
    t.count++;
    const z = model.z.get(pick.playerId);
    if (!z) continue;
    t.rated++;
    for (const c of NINE_CATEGORIES) t.sum[c] += z[c];
  }
  for (const t of totals)
    for (const c of NINE_CATEGORIES)
      t.score[c] = t.rated ? (CAPACITY * t.sum[c]) / (t.rated + 4) : null;
  return totals;
}
