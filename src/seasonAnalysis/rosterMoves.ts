import type { LeaguePlayer, LeagueTeam } from '../features/season/model.ts';

/** Virtual roster edits for Waiver and Trade. Source ESPN teams are never mutated.
 * Incoming players do not inherit their old team's lineup slot: they may take an
 * active slot vacated on the receiving team when their own ESPN eligibility allows
 * it (deterministic matching), otherwise they go to the bench. IR stays IR. Daily
 * lineups are then recomputed by the shared engine for every day. */
export function rebuildTeam(team: LeagueTeam, removeIds: ReadonlySet<number>, incoming: readonly LeaguePlayer[]): LeagueTeam {
  const roster = team.roster ?? [];
  const vacated = roster.filter(p => removeIds.has(p.espnPlayerId) && p.placement === 'active' && p.lineupSlotId !== null).map(p => p.lineupSlotId!);
  const owners: (LeaguePlayer | undefined)[] = vacated.map(() => undefined);
  function place(p: LeaguePlayer, seen: Set<number>): boolean {
    for (let i = 0; i < vacated.length; i++) {
      if (seen.has(i) || !p.eligibleSlotIds?.includes(vacated[i])) continue;
      seen.add(i);
      if (!owners[i] || place(owners[i]!, seen)) { owners[i] = p; return true; }
    }
    return false;
  }
  const regular = [...incoming].filter(p => p.placement !== 'ir').sort((a, b) => a.espnPlayerId - b.espnPlayerId);
  for (const p of regular) place(p, new Set());
  const slotOf = new Map(owners.flatMap((p, i) => p ? [[p.espnPlayerId, vacated[i]] as const] : []));
  const moved = incoming.map(p => p.placement === 'ir' ? { ...p, lineupSlotId: 13, placement: 'ir' as const }
    : slotOf.has(p.espnPlayerId) ? { ...p, lineupSlotId: slotOf.get(p.espnPlayerId)!, placement: 'active' as const }
    : { ...p, lineupSlotId: 12, placement: 'bench' as const });
  return { ...team, roster: [...roster.filter(p => !removeIds.has(p.espnPlayerId)), ...moved] };
}
export const rosterCapacity = (slots: readonly { slotId: number; count: number }[]) => ({
  regular: slots.filter(s => s.slotId <= 12).reduce((n, s) => n + s.count, 0),
  ir: slots.find(s => s.slotId === 13)?.count ?? 0,
  active: slots.filter(s => s.slotId <= 11).flatMap(s => Array<number>(s.count).fill(s.slotId)),
});
/** Count-based capacity check matching the engine's own rule. */
export function capacityIssues(team: LeagueTeam, slots: readonly { slotId: number; count: number }[]): string[] {
  const cap = rosterCapacity(slots), roster = team.roster ?? [], ir = roster.filter(p => p.placement === 'ir').length;
  const issues: string[] = [];
  if (roster.length - ir > cap.regular) issues.push(`${team.name}: kadro ${roster.length - ir}/${cap.regular} ile kapasiteyi aşıyor.`);
  if (ir > cap.ir) issues.push(`${team.name}: IR ${ir}/${cap.ir} ile kapasiteyi aşıyor.`);
  return issues;
}
