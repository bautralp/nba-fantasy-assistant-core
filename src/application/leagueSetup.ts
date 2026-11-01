import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import type { Result } from './ports.ts';
import { createInitialWorkspace } from '../domain/rules/createWorkspace.ts';
import { changeDraftOrder } from '../domain/rules/draftRules.ts';
import { validateWorkspace } from '../domain/rules/invariants.ts';
import { INITIAL_LEAGUE_RULES } from '../domain/rules/leagueRules.ts';

export interface LeagueSettings {
  readonly name: string;
  readonly season: string;
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly userTeamId: string;
  readonly draftOrder: readonly string[];
}
export type FieldErrors = Readonly<Record<string, string>>;
export const newIdentity = (): string => crypto.randomUUID();

/** Temporary form values; creating them never creates or persists a workspace. */
export function blankLeagueSettings(): LeagueSettings {
  const teams = Array.from({ length: INITIAL_LEAGUE_RULES.teamCount }, () => ({ id: newIdentity(), name: '' }));
  return { name: '', season: '', teams, userTeamId: '', draftOrder: teams.map(team => team.id) };
}
export function settingsFromWorkspace(snapshot: WorkspaceSnapshot): LeagueSettings {
  return { name: snapshot.league.name, season: snapshot.league.season, teams: snapshot.teams,
    userTeamId: snapshot.league.userTeamId ?? '', draftOrder: snapshot.draftSession?.draftOrder ?? snapshot.teams.map(team => team.id) };
}
export function validateLeagueSettings(input: LeagueSettings): FieldErrors {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) errors.name = 'Lig adını girin.';
  if (!input.season.trim()) errors.season = 'Sezonu girin.';
  const names = input.teams.map(team => team.name.trim().normalize('NFKC').toLocaleLowerCase('tr-TR'));
  input.teams.forEach((team, index) => {
    if (!names[index]) errors[team.id] = 'Takım adını girin.';
    else if (names.some((name, other) => index !== other && (name === names[index] || input.teams[other].name.trim().normalize('NFKC').toLowerCase() === team.name.trim().normalize('NFKC').toLowerCase()))) errors[team.id] = 'Takım adları farklı olmalı (büyük/küçük harf dahil).';
  });
  const ids = input.teams.map(team => team.id);
  if (ids.length !== INITIAL_LEAGUE_RULES.teamCount || new Set(ids).size !== ids.length || ids.some(id => !id.trim())) errors.teams = 'On farklı takım kimliği gerekli.';
  if (!ids.includes(input.userTeamId)) errors.userTeamId = 'Kendi takımınızı seçin.';
  if (input.draftOrder.length !== ids.length || new Set(input.draftOrder).size !== ids.length || input.draftOrder.some(id => !ids.includes(id))) errors.draftOrder = 'Draft sırası her takımı tam bir kez içermeli.';
  return errors;
}
/** The settings operation never rebuilds an existing workspace or resets its business data. */
export function applyLeagueSettings(input: LeagueSettings, current: WorkspaceSnapshot | null,
  identify: () => string = newIdentity): Result<WorkspaceSnapshot, FieldErrors> {
  const errors = validateLeagueSettings(input);
  if (Object.keys(errors).length) return { ok: false, error: errors };
  if (current && (input.teams.length !== current.teams.length || input.teams.some(team => !current.teams.some(existing => existing.id === team.id)))) {
    return { ok: false, error: { teams: 'Mevcut takım kimlikleri değiştirilemez.' } };
  }
  const base = current ?? createInitialWorkspace({ leagueId: identify(), draftSessionId: identify(), season: input.season.trim(), teamIds: input.teams.map(team => team.id) });
  let draftSession = base.draftSession;
  if (draftSession && input.draftOrder.some((id, index) => id !== draftSession!.draftOrder[index])) {
    try { draftSession = changeDraftOrder(draftSession, input.draftOrder); }
    catch { return { ok: false, error: { draftOrder: 'Draft başladıktan sonra sıra değiştirilemez. Mevcut seçimler korunur.' } }; }
  }
  const snapshot: WorkspaceSnapshot = { ...base, league: { ...base.league, name: input.name.trim(), season: input.season.trim(), userTeamId: input.userTeamId },
    teams: base.teams.map(team => ({ ...team, name: input.teams.find(item => item.id === team.id)!.name.trim() })), draftSession };
  const issues = validateWorkspace(snapshot);
  if (issues.length) return { ok: false, error: { season: 'Bu değişiklik mevcut veriyle uyumsuz. Veri seti ve pozisyon sezonu korunmalı.', integrity: issues.map(issue => `${issue.path}: ${issue.code}`).join('; ') } };
  return { ok: true, value: snapshot };
}
