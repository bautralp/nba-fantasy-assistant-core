import type { Player } from '../../domain/models/player.ts';
/** Exact numeric ESPN IDs only. Names are never evidence of identity. */
export function matchEspnPlayer(id: number, players: readonly Player[]): { status: 'matched'; playerId: string } | { status: 'unmatched' | 'ambiguous' | 'invalid' } {
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 'invalid' };
  const found = players.filter(p => { const value = p.providerIds?.espn; return value !== undefined && /^\d+$/.test(value) && Number(value) === id; });
  return found.length === 1 ? { status: 'matched', playerId: found[0].id } : { status: found.length ? 'ambiguous' : 'unmatched' };
}
