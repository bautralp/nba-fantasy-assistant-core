import type { CategoryTarget } from '../../domain/models/categories';
export const targetLabels: Record<CategoryTarget, string> = { unset: 'Belirlenmedi', top1: 'İlk 1', top3: 'İlk 3', top5: 'İlk 5', top7: 'İlk 7', punt: 'Punt' };
export const power = (value: number | null | undefined) => value == null ? 'Hesaplanamıyor' : value.toFixed(2);
export const metric = (value: number | undefined) => value === undefined ? '—' : value.toFixed(2);
export const rankLabel = (value: number | null | undefined) => value == null ? '—' : `${value}.`;
