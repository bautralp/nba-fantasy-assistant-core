/** Entirely hand-authored test data. Never written to public/data or used as an origin. */
import { rankProjections, type ROSSnapshot } from '../../../src/features/rankings/rosProjection.ts';
export function syntheticRos(): ROSSnapshot {
  const stamp = '2026-10-20T00:00:00Z', asOf = '2026-10-20';
  const players = [1, 2, 3].map(i => ({
    id: String(900000 + i), name: `Synthetic Player ${i}`, team: `SYN${i}`, positions: ['PG' as const],
    eligibility: { playerId: String(900000 + i), season: '2026-27' as const, positions: ['PG' as const], status: 'verified' as const,
      provider: 'Synthetic fixture', source: 'https://example.invalid/synthetic/eligibility', retrievedAt: stamp },
    status: 'available' as const, reason: null, minutes: 20, rosGP: 10, teamRemaining: 12,
    stats: { FGM: i + 1, FGA: 2 * i + 2, FTM: 1, FTA: 2, '3PM': 1, PTS: 2 * i + 4, REB: i + 2, AST: i,
      STL: 1, BLK: 1, TO: i, 'FG%': 50, 'FT%': 50 },
    shooting: { '2P': { attempts: 2 * i, percentage: 0.5 }, '3P': { attempts: 2, percentage: 0.5 }, FT: { attempts: 2, percentage: 0.5 } },
    role: { score: 0, strength: 0, labels: ['synthetic'], teamChange: false, newTeamGames: 0 },
    confidence: 'low' as const, uncertainty: ['Hand-authored test fixture; not a provider forecast'], injuryStatus: null,
    generatedAt: stamp, asOf, totalZ: null, rank: null,
  }));
  return rankProjections({ schemaVersion: 1, modelVersion: 1, season: '2026-27', kind: 'projected-ros', unit: 'perGame',
    generatedAt: stamp, refreshedAt: stamp, asOf, sources: [0, 1, 2, 3].map(i => ({ season: 'synthetic',
      url: `https://example.invalid/synthetic/source-${i}`, sha256: String(i).repeat(64) })),
    positionReport: { verified: 3, unresolved: 0, mismatches: [] }, players });
}
