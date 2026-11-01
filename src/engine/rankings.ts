import type { TeamId } from "../domain/models/team.ts";
import type { CategoryValues } from "../domain/models/categories.ts";
import type { TeamScore } from "./teamScores.ts";
import { categoryValues } from "./categoryScores.ts";
export type TeamRanks = CategoryValues<Readonly<Record<TeamId, number | null>>>;
export function rankTeams(
  scores: readonly Pick<TeamScore, "teamId" | "score">[],
): TeamRanks {
  return categoryValues((c) => {
    const rows = scores
      .filter((t) => t.score[c] !== null)
      .sort((a, b) => b.score[c]! - a.score[c]!);
    const positions: Record<TeamId, number | null> = Object.fromEntries(
      scores.map((t) => [t.teamId, null]),
    );
    rows.forEach(
      (t, i) =>
        (positions[t.teamId] =
          i > 0 && Math.abs(rows[i - 1].score[c]! - t.score[c]!) < 1e-10
            ? positions[rows[i - 1].teamId]
            : i + 1),
    );
    return positions;
  });
}
