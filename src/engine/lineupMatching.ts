import type { PlayerId } from "../domain/models/player.ts";
import type {
  PositionEligibility,
  RosterSlot,
} from "../domain/models/roster.ts";
import { RULES } from "./modelConfig.ts";
export type LineupPlayer = Pick<PositionEligibility, "playerId" | "positions">;
export function eligible(player: LineupPlayer, slot: RosterSlot): boolean {
  if (slot === "UTIL" || slot === "BENCH") return true;
  if (slot === "G")
    return player.positions.some((x) => x === "PG" || x === "SG" || x === "G");
  if (slot === "F")
    return player.positions.some((x) => x === "SF" || x === "PF" || x === "F");
  return player.positions.includes(slot);
}
export function matchLineup(roster: readonly LineupPlayer[]) {
  const slots = RULES.rosterSlots,
    must = slots.filter((s) => s !== "UTIL" && s !== "BENCH");
  const assigned: Record<number, PlayerId> = {};
  const order = must
    .map((slot, i) => ({
      slot,
      i,
      options: roster
        .map((p, j) => (eligible(p, slot) ? j : -1))
        .filter((j) => j >= 0),
    }))
    .sort((a, b) => a.options.length - b.options.length);
  type Task = (typeof order)[number];
  const occupant = new Map<number, Task>();
  function augment(task: Task, seen: Set<number>): boolean {
    for (const j of task.options) {
      if (seen.has(j)) continue;
      seen.add(j);
      const previous = occupant.get(j);
      if (!previous || augment(previous, seen)) {
        occupant.set(j, task);
        return true;
      }
    }
    return false;
  }
  for (const task of order) augment(task, new Set());
  const best = [...occupant.entries()].map(([j, t]) => ({ j, i: t.i })),
    used = new Set(best.map((x) => x.j));
  for (const b of best) assigned[b.i] = roster[b.j].playerId;
  const rest = roster.filter((_, j) => !used.has(j));
  let ri = 0;
  for (let i = 0; i < slots.length; i++) {
    if (assigned[i]) continue;
    if ((slots[i] === "UTIL" || slots[i] === "BENCH") && ri < rest.length)
      assigned[i] = rest[ri++].playerId;
  }
  return {
    assigned,
    filled: best.length,
    unknown: roster.filter((p) => !p.positions.length).length,
    total: roster.length,
  };
}
export function positionFit(
  roster: readonly LineupPlayer[],
  player: LineupPlayer,
) {
  const change =
    matchLineup([...roster, player]).filled - matchLineup(roster).filled;
  const missing = player.positions.length
    ? ""
    : "POS boş: yerleşim doğrulanamıyor. ";
  return {
    bonus: change * 0.55,
    reason:
      missing +
      (change > 0
        ? `Pozisyon uyumu: ${change} ilave zorunlu slot doldurulabiliyor.`
        : "Pozisyon uyumu: yeni zorunlu slot açmıyor; UTIL/BENCH yerleşimi kullanılabilir."),
  };
}
