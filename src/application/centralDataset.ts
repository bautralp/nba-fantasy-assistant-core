import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import { PROJECTION_STATS, type ProjectionDataset, type PlayerProjection } from '../domain/models/projection.ts';
import type { PositionEligibility } from '../domain/models/roster.ts';
import { validateWorkspace } from '../domain/rules/invariants.ts';
import { selectPreparation } from './workspaceCommands.ts';
import { parseSnapshot, type StatsSnapshot } from '../features/rankings/centralStats.ts';
import { parseProjections, type ROSSnapshot } from '../features/rankings/rosProjection.ts';
import { parseScenarioSnapshot } from '../projections/scenarioSnapshot.ts';
export type CentralSource = 'lastSeason' | 'projected' | 'extended';
/** Atomic, explicit adapter. Never invokes file import or relaxes its season checks. */
export function applyCentralDataset(workspace: WorkspaceSnapshot, source: CentralSource, raw: unknown, positionsRaw: unknown,
  id: () => string, importedAt: string): WorkspaceSnapshot {
  if (workspace.manualDraftLocked || selectPreparation(workspace).canOpen || workspace.draftSession?.picks.length || workspace.rosterEntries.length) throw new Error('Draft oyuncu havuzu kilitli.');
  if (workspace.league.season !== '2026-27') throw new Error('Merkezi kaynak 2026-27 ligi içindir.');
  const scenario = source === 'extended' ? parseScenarioSnapshot(raw, parseProjections(positionsRaw)) : null;
  const ros: ROSSnapshot = scenario?.projection ?? parseProjections(source === 'projected' ? raw : positionsRaw);
  const actual: StatsSnapshot | null = source === 'lastSeason' ? parseSnapshot(raw) : null;
  const datasetId = id();
  if (!datasetId.trim() || workspace.datasets.some(d => d.id === datasetId)) throw new Error('Veri seti kimliği çakıştı.');
  const provenance = { sourceSeason: source === 'lastSeason' ? '2025-26' : '2026-27',
    sourceKind: source === 'lastSeason' ? 'actual' as const : 'projected' as const,
    generatedAt: source === 'lastSeason' ? actual!.refreshedAt : ros.generatedAt,
    asOf: source === 'lastSeason' ? actual!.asOf : ros.asOf,
    gpMeaning: source === 'lastSeason' ? 'observed-last-season' as const : 'expected-remaining' as const,
    positionsSnapshotAt: ros.generatedAt, ...(scenario ? { projectionMode: 'extended' as const, modelVersion: scenario.modelVersion, sourceRevision: `${scenario.computedAt}:${Object.values(scenario.inputRevision).join(':')}`,  horizon: (scenario.sourceDataThrough === null ? 'full-season' : 'remaining-season') as 'full-season' | 'remaining-season' } : {}) };
  const dataset: ProjectionDataset = { id: datasetId, schemaVersion: 1, season: workspace.league.season, unit: 'perGame', importedAt,
    source: { name: source === 'lastSeason' ? '2025-26 Actual — Last Season' : source === 'extended' ? '2026-27 Genişletilmiş Tahmin — model senaryosu' : '2026-27 Projected — ROS', kind: 'api' }, provenance };
  const players = [...workspace.players];
  const projections: PlayerProjection[] = [], eligibility: PositionEligibility[] = [];
  const rosById = new Map(ros.players.map(p => [p.id, p]));
  const rows = actual ? actual.periods.lastSeason.players : ros.players;
  const reserved = new Set([...players.map(p => p.id), datasetId]);
  for (const row of rows) {
    const matches = players.filter(p => p.providerIds?.espn === row.id);
    if (matches.length > 1) throw new Error('ESPN oyuncu kimliği birden fazla kayda bağlı.');
    let player = matches[0];
    if (!player) {
      const playerId = id();
      if (!playerId.trim() || reserved.has(playerId)) throw new Error('Oyuncu kimliği çakıştı.');
      reserved.add(playerId);
      player = { id: playerId, name: row.name, providerIds: { espn: row.id } };
      players.push(player);
    }
    const projected = rosById.get(row.id);
    const observedDisplay = actual?.periods.lastSeason.players.find(p => p.id === row.id);
    const team = observedDisplay?.team ?? projected?.team;
    const mpg = observedDisplay ? observedDisplay.mpg : projected?.minutes;
    const identity = { playerId: player.id, datasetId, presentation: {
      ...(team && team !== 'Unknown' ? { team } : {}), ...(mpg != null ? { mpg } : {}), ...(scenario ? { modelLabel: `${scenario.players[row.id]?.tier === 'extended' ? 'Düşük güven · senaryo' : 'Standart ROS'} · ${scenario.players[row.id]?.modelVersion}` } : {}),
    } };
    if (actual) {
      const observed = actual.periods.lastSeason.players.find(p => p.id === row.id)!;
      projections.push({ ...identity, status: 'valid', gamesPlayed: observed.gp, stats: Object.fromEntries(PROJECTION_STATS.map(k => [k, observed.stats[k]])) as import('../domain/models/projection.ts').ProjectionStats });
    } else if (projected?.status === 'available' && projected.stats && projected.rosGP !== null && projected.rosGP > 0) {
      projections.push({ ...identity, status: 'valid', gamesPlayed: projected.rosGP, stats: Object.fromEntries(PROJECTION_STATS.map(k => [k, projected.stats![k]])) as import('../domain/models/projection.ts').ProjectionStats, ...(projected.rank ? { rank: projected.rank } : {}) });
    } else projections.push({ ...identity, status: 'excluded', reasons: projected?.uncertainty.length ? [...projected.uncertainty] : ['ROS projeksiyonu / kalan maç yok'] });
    eligibility.push({ playerId: player.id, season: workspace.league.season, scope: { kind: 'dataset', datasetId },
      positions: projected?.eligibility.status === 'verified' ? [...projected.positions] : [] });
  }
  const oldActive = workspace.league.activeDatasetId;
  // Preparation replaces only the active pool, keeping prior user IDs and historical datasets.
  const next: WorkspaceSnapshot = { ...workspace, league: { ...workspace.league, activeDatasetId: datasetId }, players,
    datasets: [...workspace.datasets.filter(d => d.id !== oldActive), dataset],
    projections: [...workspace.projections.filter(p => p.datasetId !== oldActive), ...projections],
    eligibility: [...workspace.eligibility.filter(e => e.scope.kind !== 'dataset' || e.scope.datasetId !== oldActive), ...eligibility] };
  if (validateWorkspace(next).length) throw new Error('Merkezi çalışma alanı doğrulanamadı.');
  return next;
}
