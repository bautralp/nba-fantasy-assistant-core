import { parseProjections, rankProjections, type ROSSnapshot } from '../features/rankings/rosProjection.ts';
export interface ScenarioPlayer {
  tier: 'standard' | 'extended'; modelVersion: string; scientificAcceptance: boolean; confidence: string;
  regularGP: number; preseasonGP: number; sourceConflict: boolean;
  sourceHistory: number[];
  roleUse: { used: string[]; weight?: number };
  availability: { expectedGames: number; range: number[]; basis: string; assumptions: string[] } | null;
  roleEvidence: { observedAt: string; validUntil: string; nbaTeamId: number; sources: { url: string; sha256: string; observedAt: string }[] } | null;
}
export interface ScenarioSnapshot {
  schemaVersion: 1; kind: 'extended-model-scenarios'; modelVersion: string; asOf: string; computedAt: string;
  sourceDataThrough: string | null; standardGeneratedAt: string; standardSources: ROSSnapshot['sources'];
  projection: ROSSnapshot; players: Record<string, ScenarioPlayer>; scientificGatesEnabled: false;
  warnings: string[]; inputRevision: { roleEvidenceSHA256: string; standardSHA256: string; rookieParametersSHA256: string; returningParametersVersion: string; modelArtifactsSHA256: string; scenarioConfigSHA256: string; historySHA256: string; rookieProfilesSHA256: string; opportunityModelSHA256: string; teamPeriodsSHA256: string | null };
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v).toISOString().slice(0, 10) === v;
const stamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const fail = (): never => { throw new Error('Genişletilmiş projeksiyon kaynağı veya revizyonu doğrulanamadı.'); };
/** Separate product boundary. Standard ROS parser/scientific gates are unchanged. */
export function parseScenarioSnapshot(v: unknown, standard?: ROSSnapshot, requireRanks = true): ScenarioSnapshot {
  if (!obj(v) || v.schemaVersion !== 1 || v.kind !== 'extended-model-scenarios' || !['scenario-9cat/1', 'unified-ros/2'].includes(String(v.modelVersion)) || v.scientificGatesEnabled !== false || !date(v.asOf) || !stamp(v.computedAt) || !stamp(v.standardGeneratedAt) || !strings(v.warnings) || !obj(v.players) || !obj(v.inputRevision) || ![v.inputRevision.roleEvidenceSHA256, v.inputRevision.standardSHA256, v.inputRevision.rookieParametersSHA256,v.inputRevision.modelArtifactsSHA256,v.inputRevision.scenarioConfigSHA256,v.inputRevision.historySHA256,v.inputRevision.rookieProfilesSHA256,v.inputRevision.opportunityModelSHA256].every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)) || !(v.sourceDataThrough === null || date(v.sourceDataThrough) && v.sourceDataThrough <= v.asOf)) return fail();
  if (!(v.inputRevision.teamPeriodsSHA256 === null || typeof v.inputRevision.teamPeriodsSHA256 === 'string' && /^[a-f0-9]{64}$/.test(v.inputRevision.teamPeriodsSHA256))) return fail();
  const projection = parseProjections(v.projection, requireRanks);
  if (projection.asOf !== v.asOf || projection.generatedAt !== v.standardGeneratedAt || JSON.stringify(projection.sources) !== JSON.stringify(v.standardSources)) return fail();
  if (standard && (standard.asOf !== v.asOf || standard.generatedAt !== v.standardGeneratedAt || JSON.stringify(standard.sources) !== JSON.stringify(v.standardSources) || standard.players.length !== projection.players.length)) return fail();
  const base = new Map(standard?.players.map(p => [p.id, p]));
  if (Object.keys(v.players).length !== projection.players.length) return fail();
  for (const p of projection.players) {
    const m = v.players[p.id];
    if (!obj(m) || !['standard','extended'].includes(String(m.tier)) || typeof m.modelVersion !== 'string' || !finite(m.regularGP) || !Number.isInteger(m.regularGP) || !finite(m.preseasonGP) || !Number.isInteger(m.preseasonGP) || typeof m.sourceConflict !== 'boolean' || !Array.isArray(m.sourceHistory) || m.sourceHistory.some(y => !Number.isInteger(y) || Number(y) >= Number(projection.season.slice(0,4)) + 1) || !obj(m.roleUse) || !strings(m.roleUse.used)) return fail();
    const o = m.opportunityEvidence;
    if (!obj(o) || o.modelVersion !== 'dated-team-opportunities/1' || o.observedGP !== m.regularGP || !(o.count === null || finite(o.count) && Number.isInteger(o.count) && o.count >= Number(m.regularGP)) || o.count === null && p.rosGP !== null && p.rosGP !== 0 && (p as unknown as { teamId: unknown }).teamId !== 0) return fail();
    const b = base.get(p.id);
    if (standard && (!b || b.name !== p.name || JSON.stringify(b.eligibility) !== JSON.stringify(p.eligibility))) return fail();
    if (b && m.tier === 'standard' && (JSON.stringify(b.stats) !== JSON.stringify(p.stats) || b.minutes !== p.minutes || b.rosGP !== p.rosGP && !(p.rosGP === 0 && (p.eligibility as unknown as { proTeamId?: number }).proTeamId === 0))) return fail();
    if (b && v.modelVersion === 'unified-ros/2') {
      // Only ranking fields may change after expanding the pool. Source-safety
      // invalidations are allowed, but cannot turn into replacement forecasts.
      const safetyInvalidation = m.sourceConflict || o.count === null ||
        obj(m.roleEvidence) && m.roleEvidence.seasonOut === true ||
        (p.eligibility as unknown as { proTeamId?: number }).proTeamId === 0;
      if (b.status === 'available' && b.stats && !safetyInvalidation) {
        for (const key of ['stats', 'shooting', 'minutes'] as const)
          if (JSON.stringify(b[key]) !== JSON.stringify(p[key])) return fail();
        if (b.rosGP !== null) {
          const withoutRanking = (row: typeof p) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'rank' && k !== 'totalZ'));
          if (JSON.stringify(withoutRanking(b)) !== JSON.stringify(withoutRanking(p)) || m.tier !== 'standard' || m.roleUse.used.length) return fail();
        }
      }
      if (b.rosGP !== null && !safetyInvalidation && b.rosGP !== p.rosGP) return fail();
    }
    if (m.tier === 'extended' && (m.scientificAcceptance !== false || p.confidence !== 'low')) return fail();
    if (m.sourceConflict && p.status === 'available') return fail();
    if (m.availability !== null) {
      const a = m.availability;
      if (!obj(a) || !finite(a.expectedGames) || a.expectedGames !== p.rosGP || !Array.isArray(a.range) || a.range.length !== 3 || a.range.some(x => !finite(x) || p.teamRemaining === null || x > p.teamRemaining) || a.range[1] !== a.expectedGames || a.range[0] > a.range[1] || a.range[1] > a.range[2] || !strings(a.assumptions) || typeof a.basis !== 'string') return fail();
    }
    if (m.roleEvidence !== null) {
      const e = m.roleEvidence;
      if (!obj(e) || e.espnId !== p.id || !stamp(e.observedAt) || e.observedAt.slice(0,10) > v.asOf || !date(e.validUntil) || e.validUntil < v.asOf || !Number.isInteger(e.nbaTeamId) || !Array.isArray(e.sources) || !e.sources.length) return fail();
      for (const s of e.sources) if (!obj(s) || typeof s.url !== 'string' || !s.url.startsWith('https://site.api.espn.com/') || typeof s.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.sha256) || !stamp(s.observedAt) || s.observedAt.slice(0,10) > v.asOf) return fail();
    }
  }
  return { ...v, projection } as unknown as ScenarioSnapshot;
}
export function rankScenarioSnapshot(v: unknown): ScenarioSnapshot {
  const snapshot = parseScenarioSnapshot(v, undefined, false);
  return parseScenarioSnapshot({ ...snapshot, projection: rankProjections(snapshot.projection) });
}
