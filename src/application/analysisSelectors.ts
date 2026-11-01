import type { WorkspaceSnapshot } from '../domain/models/workspace.ts';
import { NINE_CATEGORIES } from '../domain/models/categories.ts';
import { matchLineup } from '../engine/lineupMatching.ts';
import type { DraftView } from './draftSelectors.ts';

/** Presentation only: consumes the shared engine result; never creates scores or ranks. */
export function selectDraftAnalysis(w: WorkspaceSnapshot, v: DraftView) {
  const mine = v.scores.find(t => t.teamId === w.league.userTeamId);
  const categories = NINE_CATEGORIES.map(cat => ({
    cat, target: v.targets[cat], score: mine?.score[cat] ?? null,
    rank: w.league.userTeamId ? v.ranks[cat][w.league.userTeamId] ?? null : null,
    balance: v.plan?.byCat[cat],
    leaders: v.scores.filter(t => t.score[cat] !== null && Number.isFinite(t.score[cat]))
      .slice().sort((a, b) => b.score[cat]! - a.score[cat]! || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0))
      .slice(0, 5).map(t => ({ teamId: t.teamId, name: t.name, score: t.score[cat]!,
        rank: v.ranks[cat][t.teamId], isMine: t.teamId === w.league.userTeamId })),
  }));
  const players = new Map(w.players.map(p => [p.id, p]));
  const rosters = w.teams.map(team => {
    const members = v.roster.filter(p => p.teamId === team.id).map(p => {
      const projection = v.projectionById.get(p.playerId);
      return { playerId: p.playerId, name: players.get(p.playerId)?.name ?? p.playerId,
        positions: v.positions.get(p.playerId) ?? [],
        warning: projection?.status === 'excluded' ? `Analiz dışı: ${projection.reasons.join('; ')}`
          : !v.model?.z.has(p.playerId) ? 'Aktif projeksiyon yok.' : '' };
    });
    const lineup = team.id === w.league.userTeamId ? v.lineup : matchLineup(members);
    const placed = new Set(Object.values(lineup.assigned));
    return { ...team, isMine: team.id === w.league.userTeamId,
      draftPosition: w.draftSession ? w.draftSession.draftOrder.indexOf(team.id) + 1 : null,
      count: members.length, rated: v.scores.find(t => t.teamId === team.id)?.rated ?? 0, lineup,
      slots: w.league.rules.rosterSlots.map((slot, index) => ({ slot, index,
        player: members.find(p => p.playerId === lineup.assigned[index]) })),
      unplaced: members.filter(p => !placed.has(p.playerId)) };
  });
  const activeTargets = categories.some(c => c.target !== 'unset' && c.target !== 'punt');
  let opponentEmpty = '';
  if (!v.roster.length) opponentEmpty = 'Henüz draft seçimi yok. Seçimlerden sonra rakip analizi oluşur.';
  else if (!w.league.userTeamId) opponentEmpty = 'Rakip analizi için kendi takımınızı seçin.';
  else if (!mine?.rated) opponentEmpty = 'Takımınızda geçerli aktif projeksiyonlu oyuncu yok; rakip analizi hesaplanamıyor.';
  else if (categories.every(c => c.target === 'unset')) opponentEmpty = 'Kategori hedefi belirlenmemiş. Strateji’den hedef seçin.';
  else if (!activeTargets) opponentEmpty = 'Bütün hedefler Punt veya Belirlenmedi; etkin rakip analizi hedefi yok.';
  else if (!v.scores.some(t => t.teamId !== mine.teamId && t.rated > 0)) opponentEmpty = 'Rakip karşılaştırması için yeterli veri yok; diğer takımlarda geçerli projeksiyonlu seçim gerekli.';
  else if (!v.opponents.length) opponentEmpty = 'Hedeflenen kategorilerde motorun belirlediği rakip tehdidi yok. Bu, kategorileri kazanacağınız anlamına gelmez.';
  return { categories, rosters, activeTargets, opponentEmpty };
}
export type AnalysisView = ReturnType<typeof selectDraftAnalysis>;
