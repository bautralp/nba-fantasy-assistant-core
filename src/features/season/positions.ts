import type { BasketballPosition } from './model.ts';
export const BASKETBALL_POSITIONS: readonly BasketballPosition[] = ['PG', 'SG', 'SF', 'PF', 'C'];
/** FBA primary position IDs are 1–5; eligible lineup slot IDs for these positions are 0–4. */
export function normalizeDisplayPositions(defaultPositionId: unknown, eligibleSlots: readonly number[] | null) {
  const primaryPosition = typeof defaultPositionId === 'number' && Number.isInteger(defaultPositionId) && defaultPositionId >= 1 && defaultPositionId <= 5
    ? BASKETBALL_POSITIONS[defaultPositionId - 1] : null;
  const specific = BASKETBALL_POSITIONS.filter((_position, slotId) => eligibleSlots?.includes(slotId));
  const displayPositions = primaryPosition ? [primaryPosition, ...specific.filter(p => p !== primaryPosition)] : specific;
  return { primaryPosition, displayPositions };
}
