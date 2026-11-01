import { PROJECTION_STATS, type ProjectionStats } from '../domain/models/projection.ts';
import type { Category } from '../domain/models/categories.ts';
import { CATEGORIES, MODEL_VERSION, type AnalysisInput, type CategoryResult, type LeagueAnalysis, type TeamAnalysis } from './model.ts';
import type { LeagueTeam } from '../features/season/model.ts';
import { selectDailyLineup } from './lineup.ts';

const validId = (n: number | null): n is number => Number.isSafeInteger(n) && n! > 0;
const nonnegative = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;
const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const zero = () => Object.fromEntries(PROJECTION_STATS.map(k => [k, 0])) as unknown as Record<keyof ProjectionStats, number>;
const values = (t: ProjectionStats, c: Category) => c === 'FG%' ? t.FGA > 0 ? 100 * t.FGM / t.FGA : null : c === 'FT%' ? t.FTA > 0 ? 100 * t.FTM / t.FTA : null : t[c];
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
/** Content identity for invalidation, not a security hash. No cross-snapshot cache exists. */
function fingerprint(v: unknown): string {
  const s = JSON.stringify(v); let h = 14695981039346656037n;
  for (let i = 0; i < s.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * 1099511628211n);
  return `${s.length}:${h.toString(16)}`;
}
/** Pure, fail-closed ROS scenario evaluation. No network, store, draft capacity or standings math. */
export function analyzeLeague(input: AnalysisInput): LeagueAnalysis {
  // Identical result and revision to a single evaluation of the supplied rosters.
  return createLeagueEvaluator(input).evaluate(input.teams ?? input.league.teams, fingerprint({ ...input, modelVersion: MODEL_VERSION }));
}
export interface LeagueEvaluator {
  /** Revision of the league, projections and schedule without roster variants. */
  readonly baseRevision: string;
  /** Re-rank every team for one immutable roster set. Unchanged team objects reuse
   * their per-team result; ownership is always re-checked across the whole set. */
  evaluate(teams: readonly LeagueTeam[], revision?: string): LeagueAnalysis;
}
/** Validates league rules, schedule and projections once for many what-if roster sets
 * (Team Analysis contributions, Waiver add/drop, Trade). Same formulas as analyzeLeague. */
export function createLeagueEvaluator(input: Omit<AnalysisInput, 'teams'> & { teams?: readonly LeagueTeam[] }): LeagueEvaluator {
  const { league, projections, schedule, asOf } = input;
  const { teams: _ignored, ...base } = input;
  let baseRevision: string | null = null;
  const revisionOf = () => baseRevision ??= fingerprint({ ...base, modelVersion: MODEL_VERSION });
  const sourceRevision = fingerprint(league), early: string[] = [], warnings: string[] = [];
  let block = (message: string) => early.push(message);
  if (!day(asOf) || !Number.isFinite(Date.parse(input.dataUpdatedAt))) block('Veri tarihi doğrulanamadı.');
  if (input.lineupPolicy !== 'daily-max-games') block('Lineup politikası desteklenmiyor.');
  const categories = league.scoring.categories.map(c => c.label);
  if (!['H2H_MOST_CATEGORIES', 'H2H_EACH_CATEGORY', 'H2H_CATEGORY'].includes(league.scoring.type) || categories.length !== 9 || !CATEGORIES.every(c => categories.includes(c))) block('Lig standart 9CAT formatında değil.');
  if (league.scoring.categories.some(c => c.isReverse !== (c.label === 'TO'))) block('Kategori yönleri doğrulanamadı.');
  // The team-count check is roster-set specific; it keeps its original warning position.
  block = (message: string) => warnings.push(message);
  const slots: number[] = [];
  for (const slot of league.rosterSlots) {
    if (!Number.isSafeInteger(slot.count) || slot.count < 0 || slot.count > 50 || !Number.isSafeInteger(slot.slotId) || slot.slotId < 0 || slot.slotId > 13 && slot.count > 0) block('Roster slot kuralı desteklenmiyor.');
    else if (slot.slotId <= 11) slots.push(...Array<number>(slot.count).fill(slot.slotId));
  }
  if (!slots.length || slots.length > 50 || new Set(league.rosterSlots.map(s => s.slotId)).size !== league.rosterSlots.length) block('Aktif lineup kapasitesi doğrulanamadı.');
  if (league.lineupRules?.allowOutOfPositionScoring !== false || league.lineupRules?.hasGameLimits !== false) block('Pozisyon dışı skor / maç limiti kuralları bilinmiyor veya desteklenmiyor.');
  if (league.lineupRules?.lineupLocktimeType !== 'INDIVIDUAL_GAME' || league.lineupRules?.rosterLocktimeType !== 'FIRSTGAME_SCORINGPERIOD') block('Günlük bireysel maç kilidi doğrulanamadı.');
  if (!schedule || schedule.seasonId !== league.seasonId || schedule.asOf !== asOf || schedule.scope !== 'observed-regular-season' || !day(schedule.through) || schedule.through <= asOf || !/^[a-f0-9]{64}$/.test(schedule.source.sha256)) block('NBA takvimi / sezon / hesaplama ufku doğrulanamadı.');
  const daily = new Map<string, Set<number>>(), counts = new Map<number, number>(), gameIds = new Set<string>();
  if (schedule) for (const g of schedule.games) {
    if (!g.id || gameIds.has(g.id) || !day(g.date) || g.date <= asOf || g.date > schedule.through || g.teamIds.length !== 2 || g.teamIds[0] === g.teamIds[1] || g.teamIds.some(id => !validId(id) || id > 30)) { block('NBA takviminde geçersiz/tekrarlanan maç var.'); continue; }
    gameIds.add(g.id);
    const onDay = daily.get(g.date) ?? new Set<number>();
    for (const id of g.teamIds) { if (onDay.has(id)) block('Aynı takım/gün için çakışan NBA maçı var.'); onDay.add(id); counts.set(id, (counts.get(id) ?? 0) + 1); }
    daily.set(g.date, onDay);
  }
  const projectionMap = new Map<number, typeof projections[number][]>();
  for (const p of projections) projectionMap.set(p.espnId, [...projectionMap.get(p.espnId) ?? [], p]);
  const days = [...daily].sort(([a], [b]) => a.localeCompare(b));
  function evaluateTeam(team: LeagueTeam, ownership: ReadonlyMap<number, number>): TeamAnalysis {
    const issues: string[] = [], roster = team.roster ?? [], totals = zero();
    const coverage = { rosterPlayers: roster.length, irPlayers: roster.filter(p => p.placement === 'ir').length, matchedPlayers: 0, includedPlayers: 0, scheduledGames: 0, selectedGames: 0, expectedGames: 0 };
    if (!team.roster || !roster.length) issues.push('Takım kadrosu eksik veya boş.');
    const regular = roster.filter(p => p.placement !== 'ir');
    const capacity = league.rosterSlots.filter(s => s.slotId <= 12).reduce((n, s) => n + s.count, 0);
    const irCapacity = league.rosterSlots.find(s => s.slotId === 13)?.count ?? 0;
    if (regular.length > capacity || coverage.irPlayers > irCapacity) issues.push('Roster kapasitesi aşılıyor.');
    // An underfilled roster can be legitimate; report it without inventing missing players.
    const notes: string[] = regular.length < capacity ? ['Kadro slotlarının bir bölümü boş; yalnız dönen roster değerlendirildi.'] : [];
    const included = new Map<number, { player: typeof roster[number]; projection: typeof projections[number]; scheduledGames: number; selectedGames: number; expectedGames: number }>();
    for (const p of roster) {
      const label = `ESPN ${p.espnPlayerId}`;
      if (!validId(p.espnPlayerId) || ownership.get(p.espnPlayerId) !== 1) { issues.push(`${label}: geçersiz veya tekrarlanan kimlik.`); continue; }
      if (p.placement === 'ir') { if (p.lineupSlotId !== 13) issues.push(`${label}: IR yerleşimi doğrulanamadı.`); continue; }
      if (!['active', 'bench'].includes(p.placement) || p.lineupSlotId === null || (p.placement === 'bench' ? p.lineupSlotId !== 12 : !slots.includes(p.lineupSlotId))) { issues.push(`${label}: lineup yerleşimi doğrulanamadı.`); continue; }
      const rows = projectionMap.get(p.espnPlayerId);
      if (rows?.length !== 1) { issues.push(`${label}: ${rows?.length ? 'belirsiz' : 'eşleşmeyen'} ESPN ID.`); continue; }
      const row = rows[0]; coverage.matchedPlayers++;
      notes.push(...row.warnings.map(w => `${label}: ${w}`));
      if (row.kind !== 'ROS' || !['perGame', 'remainingTotal'].includes(row.unit)) { issues.push(`${label}: Actual/ROS veya birim uyuşmazlığı.`); continue; }
      if (row.teamState === 'unassigned' && row.nbaTeamId === 0 && p.proTeamId === 0 && row.expectedGames === 0 && row.teamRemaining === 0) {
        notes.push(`${label}: doğrulanmış ESPN takım ataması yok; mevcut atama altında 0 maç. Maç başı yetenek sıfır sayılmadı.`);
        included.set(p.espnPlayerId, { player: p, projection: row, scheduledGames: 0, selectedGames: 0, expectedGames: 0 });
        continue;
      }
      if (!validId(row.nbaTeamId) || row.nbaTeamId > 30 || row.nbaTeamId !== p.proTeamId) { issues.push(`${label}: güncel NBA takımı doğrulanamadı.`); continue; }
      if (!p.eligibleSlotIds?.some(id => slots.includes(id)) || p.placement === 'active' && !p.eligibleSlotIds.includes(p.lineupSlotId)) { issues.push(`${label}: slot uygunluğu doğrulanamadı.`); continue; }
      const games = counts.get(row.nbaTeamId) ?? 0;
      if (row.expectedGames === null || row.teamRemaining === null) { issues.push(`${label}: ROS maç beklentisi bilinmiyor; katkı ve sıra üretilmedi.`); continue; }
      if (!nonnegative(row.expectedGames) || !nonnegative(row.teamRemaining) || row.expectedGames > row.teamRemaining || row.teamRemaining !== games) { issues.push(`${label}: kalan maç kapsamı takvimle uyuşmuyor.`); continue; }
      // Verified zero future games contributes zero even without a rate estimate.
      if (row.expectedGames > 0 && (!row.stats || PROJECTION_STATS.some(k => !nonnegative(row.stats![k])) || row.stats.FGM > row.stats.FGA || row.stats.FTM > row.stats.FTA)) { issues.push(`${label}: ROS istatistiği eksik/geçersiz.`); continue; }
      included.set(p.espnPlayerId, { player: p, projection: row, scheduledGames: games, selectedGames: 0, expectedGames: 0 });
    }
    for (const [, nbaTeams] of days) {
      const available = [...included.values()].filter(p => p.projection.expectedGames! > 0 && nbaTeams.has(p.projection.nbaTeamId!));
      for (const id of selectDailyLineup(available.map(p => p.player), slots)) included.get(id)!.selectedGames++;
    }
    const contributions = [...included].map(([espnId, p]) => {
      const { projection: row } = p;
      p.expectedGames = p.selectedGames * (row.teamRemaining! > 0 ? row.expectedGames! / row.teamRemaining! : 0);
      const scale = row.unit === 'perGame' ? p.expectedGames : row.expectedGames! > 0 ? p.expectedGames / row.expectedGames! : 0;
      if (scale > 0 && row.stats) for (const k of PROJECTION_STATS) totals[k] += row.stats[k] * scale;
      coverage.scheduledGames += p.scheduledGames; coverage.selectedGames += p.selectedGames; coverage.expectedGames += p.expectedGames;
      if (p.expectedGames > 0) coverage.includedPlayers++;
      return { espnId, scheduledGames: p.scheduledGames, selectedGames: p.selectedGames, expectedGames: p.expectedGames };
    });
    if (!coverage.expectedGames) issues.push('Hesaba dahil edilebilen beklenen maç yok.');
    return { teamId: team.espnTeamId, name: team.name, coverage, warnings: [...new Set([...issues, ...notes])], partialTotals: totals, complete: !issues.length, contributions };
  }
  // Per-team results depend only on the team object and which of its players are
  // owned more than once in the evaluated set; both are part of the cache key.
  const cache = new WeakMap<LeagueTeam, Map<string, TeamAnalysis>>();
  function cachedTeam(team: LeagueTeam, ownership: ReadonlyMap<number, number>): TeamAnalysis {
    const key = (team.roster ?? []).filter(p => ownership.get(p.espnPlayerId) !== 1).map(p => p.espnPlayerId).join(',');
    let byKey = cache.get(team);
    if (!byKey) { byKey = new Map(); cache.set(team, byKey); }
    let result = byKey.get(key);
    if (!result) { result = evaluateTeam(team, ownership); byKey.set(key, result); }
    // Callers receive independent arrays; cached results are never shared mutable state.
    return structuredClone(result);
  }
  return { get baseRevision() { return revisionOf(); }, evaluate(teams, revision) {
  const teamWarnings = teams.length < 2 || new Set(teams.map(t => t.espnTeamId)).size !== teams.length ? ['Karşılaştırılabilir en az iki farklı takım gerekli.'] : [];
  const allWarnings = [...early, ...teamWarnings, ...warnings];
  const ownership = new Map<number, number>();
  for (const t of teams) for (const p of t.roster ?? []) ownership.set(p.espnPlayerId, (ownership.get(p.espnPlayerId) ?? 0) + 1);
  const teamResults: TeamAnalysis[] = teams.map(team => cachedTeam(team, ownership));
  const globallyBlocked = allWarnings.length > 0;
  const rankings = Object.fromEntries(CATEGORIES.map(category => {
    const rows: CategoryResult[] = teamResults.map(t => ({ teamId: t.teamId, name: t.name, projectedValue: !globallyBlocked && t.complete ? values(t.partialTotals, category) : null, rank: null, powerScore: null, leaderGap: null, aboveGap: null, belowGap: null, coverage: t.coverage, warnings: [...t.warnings] }));
    const comparable = rows.every(r => r.projectedValue !== null);
    if (!comparable) { for (const r of rows) r.warnings.push('Lig kapsamı eksik; bu kategoride sıra ve güç puanı üretilmedi.'); }
    else {
      const direction = category === 'TO' ? -1 : 1;
      rows.sort((a, b) => direction * (b.projectedValue! - a.projectedValue!) || a.teamId - b.teamId);
      const mean = rows.reduce((s, r) => s + r.projectedValue!, 0) / rows.length;
      // Sample standard deviation matches the existing engine's statistical convention.
      const sd = Math.sqrt(rows.reduce((s, r) => s + (r.projectedValue! - mean) ** 2, 0) / (rows.length - 1));
      let rank = 1;
      rows.forEach((r, i) => {
        if (i > 0 && !near(r.projectedValue!, rows[i - 1].projectedValue!)) rank = i + 1;
        r.rank = rank; r.powerScore = sd > 0 ? direction * (r.projectedValue! - mean) / sd : 0;
        r.leaderGap = direction * (rows[0].projectedValue! - r.projectedValue!);
        const above = rows.slice(0, i).reverse().find(x => !near(x.projectedValue!, r.projectedValue!));
        const below = rows.slice(i + 1).find(x => !near(x.projectedValue!, r.projectedValue!));
        r.aboveGap = above ? direction * (above.projectedValue! - r.projectedValue!) : null;
        r.belowGap = below ? direction * (r.projectedValue! - below.projectedValue!) : null;
        if (!sd) r.warnings.push('Sıfır varyans: tüm takımlar eşit; z = 0.');
      });
    }
    return [category, rows];
  })) as LeagueAnalysis['rankings'];
  return { status: !globallyBlocked && teams.length >= 2 && CATEGORIES.every(c => rankings[c].every(r => r.rank !== null)) ? 'ready' : 'blocked', modelVersion: MODEL_VERSION, projectionKind: 'ROS', sourceRevision, datasetRevision: input.datasetRevision, scheduleRevision: schedule?.source.sha256 ?? null, revision: revision ?? fingerprint({ base: revisionOf(), teams }), asOf, dataUpdatedAt: input.dataUpdatedAt, horizon: { fromExclusive: asOf, through: schedule?.through ?? null }, lineupPolicy: input.lineupPolicy, scope: 'Gözlenen normal sezon fikstürü · sabit kadro · günlük maksimum maç senaryosu', warnings: [...new Set([...allWarnings, 'Koşullu ROS senaryosu: kadrolar sabit, IR aktivasyonu ve gelecekteki transferler yok.', 'Günlük maksimum maç: aktif oyuncu önceliği, sonra ESPN ID; kategori optimizasyonu yapılmaz.', 'ROS GP / takımın kalan maçı her seçili maça eşit dağıtılır; sakatlığın tarihini veya boşalan slota bench ikamesini tahmin etmez.', 'Planlanmamış Cup maçları, ertelenen maçların yeni tarihleri ve fantasy playoff sınırları toplamda varsayılmaz.'])], coverage: { totalTeams: teamResults.length, completeTeams: teamResults.filter(t => t.complete).length, rankedCategories: CATEGORIES.filter(c => rankings[c].length >= 2 && rankings[c].every(r => r.rank !== null)).length }, teams: teamResults, rankings };
  } };
}
