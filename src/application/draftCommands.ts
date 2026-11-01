import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import type { CategoryTargets } from '../domain/models/categories.ts';
import { appendDraftPick, removeDraftPick, snakeTeamAt } from '../domain/rules/draftRules.ts';
import { validateWorkspace } from '../domain/rules/invariants.ts';

export type DraftCommand =
  | { kind: 'assign'; playerId: string; teamId: string; confirmed?: boolean }
  | { kind: 'transfer'; playerId: string; teamId: string; confirmed?: boolean }
  | { kind: 'remove'; playerId: string }
  | { kind: 'undo'; playerId: string }
  | { kind: 'strategy'; targets: CategoryTargets };

/** Pure, atomic commands. Call against the latest accepted snapshot, then accept the result. */
export function applyDraftCommand(workspace: WorkspaceSnapshot, command: DraftCommand): WorkspaceSnapshot {
  let next: WorkspaceSnapshot;
  if (command.kind === 'strategy') {
    const teamId = workspace.league.userTeamId;
    if (!teamId) throw new Error('Önce kendi takımınızı seçin.');
    const strategy = { leagueId: workspace.league.id, teamId, targets: { ...command.targets } };
    next = { ...workspace, strategies: [...workspace.strategies.filter(s => s.teamId !== teamId), strategy] };
  } else {
    const session = workspace.draftSession;
    if (!session) throw new Error('Draft oturumu bulunmuyor.');
    let updated = session;
    if (command.kind === 'assign') {
      if (!workspace.players.some(p => p.id === command.playerId)) throw new Error('Oyuncu bulunamadı.');
      try {
        updated = appendDraftPick(session, { playerId: command.playerId, teamId: command.teamId, outOfTurnConfirmed: command.confirmed === true }, workspace.league.rules);
      } catch (error) {
        const messages: Record<string, string> = {
          'Draft is full': 'Draft tamamlandı; yeni seçim yapılamaz.',
          'Unknown draft team': 'Geçersiz draft takımı.',
          'Player already selected': 'Oyuncu zaten seçilmiş.',
          'Team is full': 'Takımın kadrosu dolu.',
          'Out-of-turn assignment requires confirmation': 'Sıra dışı seçim için açık onay gerekli.',
        };
        throw new Error(error instanceof Error ? messages[error.message] ?? error.message : 'Seçim uygulanamadı.');
      }
    } else if (command.kind === 'transfer') {
      const index = session.picks.findIndex(p => p.playerId === command.playerId);
      if (index < 0) throw new Error('Oyuncu seçili değil.');
      if (!session.draftOrder.includes(command.teamId)) throw new Error('Geçersiz takım.');
      const previous = session.picks[index];
      if (previous.teamId === command.teamId) throw new Error('Oyuncu zaten bu takımda.');
      if (session.picks.filter(p => p.teamId === command.teamId).length >= workspace.league.rules.rosterSize) throw new Error('Takımın kadrosu dolu.');
      const historicalIndex = previous.selectionIndex ?? index;
      const outOfTurn = snakeTeamAt(session.draftOrder, historicalIndex, workspace.league.rules) !== command.teamId;
      if (outOfTurn && command.confirmed !== true) throw new Error('Yeni takım için sıra dışı seçim onayı gerekli.');
      updated = { ...session, picks: session.picks.map((p, i) => i !== index ? p : {
        playerId: p.playerId, teamId: command.teamId, selectionIndex: historicalIndex,
        ...(outOfTurn ? { outOfTurnConfirmed: true } : {}),
      }) };
    } else {
      if (command.kind === 'undo' && session.picks.at(-1)?.playerId !== command.playerId) throw new Error('Son seçim değişti. Yeniden inceleyin.');
      updated = removeDraftPick(session, command.playerId);
    }
    next = { ...workspace, draftSession: updated };
  }
  const issues = validateWorkspace(next);
  if (issues.length) throw new Error(`İşlem bütünlük kontrolünden geçemedi: ${issues.map(i => i.code).join(', ')}`);
  return next;
}
