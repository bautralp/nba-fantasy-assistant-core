import type { TeamImpact } from '../../seasonAnalysis/teamInsights.ts';
import { NOTABLE_DELTA_Z, formatDelta } from './strategyPresentation.ts';

/** Strengthened/weakened categories by |Δz| ≥ 0.15 league SD; only computed values. */
export function tradeTeamSummary(impact: TeamImpact, mine: boolean): string[] {
  const item = (c: TeamImpact['categories'][number]) => `${c.category} ${formatDelta(c.category, c.delta)}${c.category === 'TO' ? (c.delta > 0 ? ' (daha fazla top kaybı)' : ' (daha az top kaybı)') : ''}${c.weight === 0 && mine ? ' (punt)' : ''}`;
  const up = impact.categories.filter(c => c.deltaZ >= NOTABLE_DELTA_Z).sort((a, b) => b.deltaZ - a.deltaZ);
  const down = impact.categories.filter(c => c.deltaZ <= -NOTABLE_DELTA_Z).sort((a, b) => a.deltaZ - b.deltaZ);
  const lines: string[] = [];
  lines.push(up.length ? `Güçleniyor: ${up.map(item).join(', ')}.` : 'Belirgin güçlendiği kategori yok.');
  if (down.length) lines.push(`Zayıflıyor: ${down.map(item).join(', ')}.`);
  if (mine) {
    const goals = impact.categories.filter(c => c.targeted);
    if (goals.length) {
      const gain = goals.filter(c => c.deltaZ >= NOTABLE_DELTA_Z).map(c => c.category), loss = goals.filter(c => c.deltaZ <= -NOTABLE_DELTA_Z).map(c => c.category);
      lines.push(`Hedeflerin açısından: ${gain.length ? `${gain.join(', ')} güçleniyor` : 'hedef kategorilerinde belirgin kazanç yok'}${loss.length ? `; ${loss.join(', ')} zayıflıyor` : ''}. Sağlanan hedef ${impact.goalsMetBefore} → ${impact.goalsMetAfter}.`);
    }
  }
  return lines;
}
