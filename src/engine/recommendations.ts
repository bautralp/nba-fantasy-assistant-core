import type { Player } from "../domain/models/player.ts";
import type { PlayerProjection } from "../domain/models/projection.ts";
import type { RosterEntry } from "../domain/models/roster.ts";
import type { Team, TeamId } from "../domain/models/team.ts";
import type { CategoryTargets } from "../domain/models/categories.ts";
import type { CalculationModel } from "./model.ts";
import { teamScores } from "./teamScores.ts";
import { rankTeams } from "./rankings.ts";
import { categoryBalance } from "./categoryBalance.ts";
import { opponentAnalysis } from "./opponentAnalysis.ts";
import { positionFit, type LineupPlayer } from "./lineupMatching.ts";
import { CAPACITY, MAX_PICKS } from "./modelConfig.ts";
export interface RecommendationInput {
  readonly players: readonly Player[];
  /** Only projections from the selected dataset. */
  readonly projections: readonly PlayerProjection[];
  readonly teams: readonly Team[];
  readonly roster: readonly RosterEntry[];
  /** Eligibility already resolved to the active league/dataset/season. */
  readonly eligibility: readonly LineupPlayer[];
  readonly teamId: TeamId;
  readonly targets: CategoryTargets;
  readonly model: CalculationModel;
}
export function recommendations(input: RecommendationInput) {
  const {
    players,
    projections,
    teams,
    roster,
    eligibility,
    teamId,
    targets,
    model,
  } = input;
  if (
    roster.length >= MAX_PICKS ||
    roster.filter((p) => p.teamId === teamId).length >= CAPACITY ||
    !Object.values(targets).some((t) =>
      ["top1", "top3", "top5", "top7"].includes(t),
    ) ||
    !model.usable
  )
    return [];
  const taken = new Set(roster.map((p) => p.playerId)),
    base = teamScores(teams, roster, model),
    ranks = rankTeams(base);
  const plan = categoryBalance(base, teamId, targets, ranks),
    threat = opponentAnalysis(base, teamId, targets);
  const positions = new Map(eligibility.map((e) => [e.playerId, e]));
  const lookup = (id: string): LineupPlayer =>
    positions.get(id) ?? { playerId: id, positions: [] };
  const known = new Set(players.map((p) => p.id));
  const mine = roster
    .filter((p) => p.teamId === teamId && known.has(p.playerId))
    .map((p) => lookup(p.playerId));
  const rank = new Map(projections.map((p) => [p.playerId, p.rank]));
  const all = [];
  for (const p of players) {
    const z = model.z.get(p.id);
    if (taken.has(p.id) || !z) continue;
    let score = 0;
    for (const item of plan.entries) score += item.priority * z[item.cat];
    const fit = positionFit(mine, lookup(p.id));
    score += fit.bonus;
    all.push({ playerId: p.id, score, fit });
  }
  all.sort(
    (a, b) =>
      b.score - a.score ||
      (rank.get(a.playerId) ?? 9999) - (rank.get(b.playerId) ?? 9999),
  );
  return all.slice(0, 5).map((r) => {
    const after = teamScores(teams, roster, model, {
        teamId,
        playerId: r.playerId,
      }),
      afterRanks = rankTeams(after),
      z = model.z.get(r.playerId)!;
    const beforeMe = base.find((t) => t.teamId === teamId)!,
      afterMe = after.find((t) => t.teamId === teamId)!;
    const contributions = plan.entries
      .map((item) => {
        const cat = item.cat,
          br = ranks[cat][teamId],
          ar = afterRanks[cat][teamId];
        const gain = (afterMe.score[cat] ?? 0) - (beforeMe.score[cat] ?? 0),
          related = threat.filter((t) => t.cat === cat);
        return {
          cat,
          gain,
          br,
          ar,
          goal: item.target,
          z: z[cat],
          weighted: z[cat] * item.priority,
          need: item.status,
          priority: item.priority,
          paceGap: item.paceGap,
          rivals: related.map((x) => ({ name: x.team, ahead: x.ahead })),
        };
      })
      .sort((a, b) => b.weighted - a.weighted);
    return {
      ...r,
      contributions,
      positive: contributions.filter((c) => c.weighted > 0.025),
    };
  });
}
