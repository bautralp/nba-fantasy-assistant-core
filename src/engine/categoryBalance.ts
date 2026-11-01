import {
  NINE_CATEGORIES,
  type Category,
  type CategoryTargets,
} from "../domain/models/categories.ts";
import type { TeamId } from "../domain/models/team.ts";
import type { TeamScore } from "./teamScores.ts";
import { rankTeams, type TeamRanks } from "./rankings.ts";
import {
  CAPACITY,
  TARGET_PACE,
  TARGET_TIER,
  clamp,
  type ActiveTarget,
} from "./modelConfig.ts";
export function categoryBalance(
  scores: readonly TeamScore[],
  teamId: TeamId,
  targets: CategoryTargets,
  ranks: TeamRanks = rankTeams(scores),
) {
  const me = scores.find((t) => t.teamId === teamId)!,
    selected = me.count,
    remain = Math.max(1, CAPACITY - selected);
  const stage =
    selected < 4 ? "İlk turlar" : selected < 9 ? "Orta turlar" : "Son turlar";
  const entries = [];
  for (const cat of NINE_CATEGORIES) {
    const target = targets[cat];
    if (!(target in TARGET_PACE)) continue;
    const goal = target as ActiveTarget;
    const desired = TARGET_PACE[goal],
      actual = me.sum[cat],
      expectedNow = selected * desired,
      paceGap = expectedNow - actual;
    const futureNeed = (CAPACITY * desired - actual) / remain,
      normalizedLag = selected ? paceGap / Math.sqrt(selected) : 0;
    const demand =
      0.55 * clamp(futureNeed, -2.5, 2.5) + 0.5 * clamp(normalizedLag, -3, 3);
    let priority = clamp((1.1 + 0.75 * demand) * TARGET_TIER[goal], 0.26, 2.4);
    const other = scores.filter((t) => t.teamId !== teamId && t.rated >= 2);
    const ahead =
      me.rated >= 2
        ? other.filter(
            (t) =>
              t.score[cat] !== null &&
              me.score[cat] !== null &&
              t.score[cat]! > me.score[cat]! + 0.15,
          )
        : [];
    const close =
      me.rated >= 2
        ? other.filter(
            (t) =>
              t.score[cat] !== null &&
              me.score[cat] !== null &&
              Math.abs(t.score[cat]! - me.score[cat]!) <= 0.35,
          )
        : [];
    if (ahead.length && paceGap > -0.4)
      priority = clamp(
        priority + Math.min(0.16, ahead.length * 0.03),
        0.26,
        2.4,
      );
    const status =
      selected === 0
        ? "Başlangıç"
        : normalizedLag > 1
          ? "Kritik açık"
          : normalizedLag > 0.25
            ? "Takviye gerekli"
            : normalizedLag < -0.9
              ? "Hedefin önünde"
              : "Hedefe yakın";
    entries.push({
      cat,
      target: goal,
      status,
      desired,
      actual,
      selected,
      remaining: CAPACITY - selected,
      expectedNow,
      paceGap,
      futureNeed,
      priority,
      rank: ranks[cat][teamId],
      ahead: ahead.slice(0, 3).map((t) => t.name),
      close: close.slice(0, 2).map((t) => t.name),
    });
  }
  return {
    selected,
    remaining: CAPACITY - selected,
    stage,
    entries,
    byCat: Object.fromEntries(entries.map((e) => [e.cat, e])) as Partial<
      Record<Category, (typeof entries)[number]>
    >,
  };
}
