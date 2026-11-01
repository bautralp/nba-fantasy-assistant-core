import { loadAnalysisSources } from './loadAnalysis.ts';
import { loadScenarios } from '../projections/loadScenarios.ts';
import { adaptCentralRos } from './centralAdapter.ts';

/** Commit only a complete, validated publication. Standard is a source reference,
 * never a fallback for an unavailable extended projection. */
export async function loadPowerRankings(base: string, signal: AbortSignal, now: number) {
  const sources = await loadAnalysisSources(base, signal);
  const scenario = await loadScenarios(base, signal, sources.snapshot);
  const age = now - Date.parse(sources.snapshot.generatedAt);
  if (age > 36 * 3600000 || age < -5 * 60000) throw new Error('Power Rankings kaynak tarihi geçersiz.');
  const adapted = adaptCentralRos(scenario.projection, sources.schedule);
  return {
    projections: adapted.projections, schedule: sources.schedule,
    asOf: scenario.asOf, dataUpdatedAt: scenario.projection.generatedAt,
    datasetRevision: `${scenario.modelVersion}:${scenario.computedAt}:${scenario.inputRevision.roleEvidenceSHA256}:${scenario.inputRevision.modelArtifactsSHA256}:${scenario.inputRevision.scenarioConfigSHA256}:${scenario.inputRevision.historySHA256}:${scenario.inputRevision.rookieProfilesSHA256}:${scenario.inputRevision.opportunityModelSHA256}:${scenario.inputRevision.teamPeriodsSHA256}:${adapted.datasetRevision}`,
  };
}
