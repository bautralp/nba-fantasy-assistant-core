import type { LeaguePlayer } from '../features/season/model.ts';
/** Maximum cardinality bipartite matching. Slot IDs are ESPN FBA IDs, including G/F/UTIL.
 * Stable active-first, then ESPN-ID priority. No category optimization or injury clairvoyance.
 * Reassignment prevents a flexible guard occupying the only slot a specialist can use. */
export function selectDailyLineup(players: readonly LeaguePlayer[], slots: readonly number[]): number[] {
  const owners: (LeaguePlayer | undefined)[] = slots.map(() => undefined);
  function place(p: LeaguePlayer, seen: Set<number>): boolean {
    for (let i = 0; i < slots.length; i++) {
      if (seen.has(i) || !p.eligibleSlotIds?.includes(slots[i])) continue;
      seen.add(i);
      if (!owners[i] || place(owners[i]!, seen)) { owners[i] = p; return true; }
    }
    return false;
  }
  const ordered = [...players].sort((a, b) => Number(b.placement === 'active') - Number(a.placement === 'active') || a.espnPlayerId - b.espnPlayerId);
  for (const p of ordered) place(p, new Set());
  return owners.flatMap(p => p ? [p.espnPlayerId] : []);
}
