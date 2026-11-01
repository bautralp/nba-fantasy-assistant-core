import {
  NINE_CATEGORIES,
  type CategoryTargets,
} from "../domain/models/categories.ts";
import type { TeamId } from "../domain/models/team.ts";
import type { TeamScore } from "./teamScores.ts";
import { TARGET_PACE, type ActiveTarget } from "./modelConfig.ts";
export function opponentAnalysis(
  scores: readonly TeamScore[],
  teamId: TeamId,
  targets: CategoryTargets,
) {
  const mine = scores.find((t) => t.teamId === teamId)!;
  const out: {
    cat: (typeof NINE_CATEGORIES)[number];
    team: string;
    teamId: TeamId;
    gap: number;
    ahead: boolean;
    level: ActiveTarget;
    rated: number;
    confidence: string;
  }[] = [];
  if (mine.rated === 0) return out;
  for (const cat of NINE_CATEGORIES) {
    const target = targets[cat];
    if (!(target in TARGET_PACE)) continue;
    for (const t of scores) {
      if (t.teamId === teamId || t.rated === 0) continue;
      const gap = t.score[cat]! - mine.score[cat]!;
      if (gap > 0.000001 || Math.abs(gap) < 0.65)
        out.push({
          cat,
          team: t.name,
          teamId: t.teamId,
          gap,
          ahead: gap > 0,
          level: target as ActiveTarget,
          rated: t.rated,
          confidence: Math.min(mine.rated, t.rated) < 3 ? "Düşük" : "Orta",
        });
    }
  }
  const order = { top1: 0, top3: 1, top5: 2, top7: 3 };
  return out.sort(
    (a, b) =>
      (a.ahead === b.ahead ? 0 : a.ahead ? -1 : 1) ||
      order[a.level] - order[b.level] ||
      b.gap - a.gap,
  );
}
