import { parseProjections, type ROSSnapshot } from '../features/rankings/rosProjection.ts';
import type { AnalysisProjection, NbaSchedule } from './model.ts';

const fail = (): never => { throw new Error('NBA analiz takvimi doğrulanamadı.'); };
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseAnalysisSchedule(v: unknown, options: { allowSynthetic?: boolean } = {}): NbaSchedule {
  if (!obj(v) || v.schemaVersion !== 1 || !Number.isSafeInteger(v.seasonId) || !day(v.asOf) || !day(v.through) || v.through <= v.asOf || typeof v.retrievedAt !== 'string' || !Number.isFinite(Date.parse(v.retrievedAt)) || v.scope !== 'observed-regular-season' || !obj(v.source) || typeof v.source.url !== 'string' || !(v.source.url === `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules/nba_schedule_${v.seasonId}.parquet` || options.allowSynthetic === true && obj(v.provenance) && v.provenance.kind === 'synthetic' && v.source.url === 'https://example.invalid/public-core/schedule.json') || typeof v.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.source.sha256) || !Array.isArray(v.games) || v.games.length > 1230 || !v.games.length) return fail();
  const ids = new Set<string>();
  for (const g of v.games) {
    if (!obj(g) || typeof g.id !== 'string' || !/^\d+$/.test(g.id) || ids.has(g.id) || !day(g.date) || g.date <= v.asOf || g.date > v.through || !Array.isArray(g.teamIds) || g.teamIds.length !== 2 || g.teamIds[0] === g.teamIds[1] || g.teamIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 30)) return fail();
    ids.add(g.id);
  }
  return v as unknown as NbaSchedule;
}
/** Central ESPN-native numeric IDs are validated independently of the draft workspace. */
export function adaptCentralRos(raw: unknown, schedule: NbaSchedule | null): { snapshot: ROSSnapshot; projections: AnalysisProjection[]; datasetRevision: string } {
  const snapshot = parseProjections(raw);
  if (schedule && (snapshot.asOf !== schedule.asOf || Number(snapshot.season.slice(0, 4)) + 1 !== schedule.seasonId || !snapshot.sources.some(s => s.url === schedule.source.url && s.sha256 === schedule.source.sha256))) throw new Error('NBA takvimi ile ROS kaynak revizyonu uyuşmuyor. Veriler yenilenmeli.');
  const metadata = (raw as { players: { teamId?: unknown; eligibility?: { proTeamId?: unknown }; teamIdentity?: { status?: string; teamId?: number; source?: string; observedAt?: string } }[] }).players;
  const projections: AnalysisProjection[] = snapshot.players.map((p, i) => {
    const teamId = metadata[i].teamId, identity = metadata[i].teamIdentity;
    // Version-1 snapshots already carry dated, exact-ID ESPN eligibility. A
    // verified catalog zero is a known unassigned state, including legacy ROS
    // files whose old generator incorrectly left GP null for team zero.
    const catalogZero = metadata[i].eligibility?.proTeamId === 0 && p.eligibility.status === 'verified' && p.eligibility.provider === 'ESPN Fantasy FBA' && p.eligibility.source === 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/players?view=kona_player_info' && p.eligibility.retrievedAt.slice(0, 10) <= snapshot.asOf;
    const identityAgrees = identity === undefined || identity.status === 'unassigned' && identity.teamId === 0 && identity.source === p.eligibility.source && identity.observedAt === p.eligibility.retrievedAt;
    const unassigned = teamId === 0 && catalogZero && identityAgrees && (p.rosGP === null || p.rosGP === 0) && (p.teamRemaining === null || p.teamRemaining === 0);
    return { espnId: Number(p.id), teamState: unassigned ? 'unassigned' : typeof teamId === 'number' && teamId > 0 && teamId <= 30 ? 'assigned' : 'unknown', nbaTeamId: unassigned ? 0 : typeof teamId === 'number' && Number.isSafeInteger(teamId) && teamId > 0 && teamId <= 30 ? teamId : null, kind: 'ROS', unit: snapshot.unit,
      stats: p.stats, expectedGames: unassigned ? 0 : p.rosGP, teamRemaining: unassigned ? 0 : p.teamRemaining,
      warnings: [...p.uncertainty, ...(unassigned ? ['Doğrulanmış ESPN takım ataması yok: mevcut atama altında 0 maç; maç başı yetenek korunur.'] : []), ...(p.confidence === 'low' ? ['Düşük ROS güveni.'] : []), ...(p.injuryStatus ? [`Sakatlık durumu ${p.injuryStatus}; dönüş tarihi modellenmez.`] : [])] };
  });
  return { snapshot, projections, datasetRevision: `${snapshot.modelVersion}:${snapshot.generatedAt}:${snapshot.sources.map(s => s.sha256).join(':')}` };
}
