import { useState } from 'react';
import { useWorkspace } from '../../app/WorkspaceContext';
import { snakeTeamAt } from '../../domain/rules/draftRules';
import { projectionValue, type DraftView } from '../../application/draftSelectors';
import { applyDraftCommand, type DraftCommand } from '../../application/draftCommands';
import { NINE_CATEGORIES } from '../../domain/models/categories';
import { DraftDialog } from './DraftDialog';
import { formatStat } from './formatStat';
export function PlayerAssignmentDialog({ playerId, view: v, onClose, onSuccess }: { playerId: string; view: DraftView; onClose: () => void; onSuccess: (text: string) => void }) {
  const { workspace: w, revision, saving, store } = useWorkspace();
  const [openedRevision] = useState(revision);
  const [teamId, setTeamId] = useState(v.ownership.get(playerId) ?? v.status.teamId ?? '');
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
  if (!w) return null;
  const player = w.players.find(p => p.id === playerId), session = w.draftSession;
  const pickIndex = session?.picks.findIndex(p => p.playerId === playerId) ?? -1;
  const pick = session?.picks[pickIndex], projection = v.projectionById.get(playerId);
  const historicalIndex = pick?.selectionIndex ?? (pick ? pickIndex : session?.picks.length ?? 0);
  const expected = session ? snakeTeamAt(session.draftOrder, historicalIndex, w.league.rules) : null;
  const mismatch = teamId !== expected, stale = openedRevision !== revision;
  const run = (kind: 'assign' | 'transfer' | 'remove') => {
    try {
      const current = store.getSnapshot();
      if (!current.workspace || current.revision !== openedRevision) throw new Error('Çalışma alanı değişti. Pencereyi kapatıp oyuncuyu yeniden açın.');
      const command: DraftCommand = kind === 'remove' ? { kind, playerId } : { kind, playerId, teamId, confirmed };
      const next = applyDraftCommand(current.workspace, command);
      if (!store.accept(next)) throw new Error('İşlem uygulanamadı. Kayıt tamamlandıktan sonra yeniden deneyin.');
      onSuccess(kind === 'remove' ? 'Seçim kaldırıldı.' : kind === 'transfer' ? 'Oyuncunun takımı değiştirildi.' : 'Draft seçimi belleğe uygulandı.'); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'İşlem uygulanamadı.'); }
  };
  const full = v.roster.filter(p => p.teamId === teamId).length >= w.league.rules.rosterSize && pick?.teamId !== teamId;
  return <DraftDialog title={player?.name ?? 'Oyuncu bulunamadı'} onClose={onClose}>
    <p>{v.positions.get(playerId)?.join('/') || 'Pozisyon bilinmiyor'} · {pick ? `Seçili: ${w.teams.find(t => t.id === pick.teamId)?.name} · Tarihsel seçim ${historicalIndex + 1}` : 'Seçilmemiş'}</p>
    <p className="muted">{v.dataset?.unit === 'totals' ? 'Sezon toplamı (totals)' : v.dataset ? 'Maç başına (perGame)' : 'Aktif veri seti yok'}</p>
    {projection?.status === 'valid' ? <dl className="projection-summary">{['GP', ...NINE_CATEGORIES].map(c => <div key={c}><dt>{c}</dt><dd>{formatStat(projectionValue(projection, c), c.endsWith('%'))}</dd></div>)}</dl> : <p className="notice">{projection?.status === 'excluded' ? `Analiz dışı: ${projection.reasons.join('; ')}` : 'Aktif projeksiyon yok. Mevcut sahiplik korunuyor.'}</p>}
    <label>Atanacak takım<select value={teamId} onChange={e => { setTeamId(e.target.value); setConfirmed(false); setError(''); }}>{w.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    {mismatch && (!pick || pick.teamId !== teamId) && <label className="check-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{pick ? 'Bu tarihsel seçimde beklenen' : 'Sıradaki'} takım {w.teams.find(t => t.id === expected)?.name ?? 'yok'}, ancak oyuncuyu {w.teams.find(t => t.id === teamId)?.name} takımına atıyorsunuz. Sıra dışı seçimi onaylıyorum.</label>}
    {stale && <p role="alert">Çalışma alanı değişti. Pencereyi kapatıp oyuncuyu yeniden açın.</p>}
    {full && <p role="alert">Takımın kadrosu dolu.</p>}
    {!pick && v.status.completed && <p role="alert">Draft tamamlandı.</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
    <div className="actions"><button className="primary" disabled={saving || stale || full || !session || !player || !teamId || (mismatch && !confirmed) || (pick ? pick.teamId === teamId : v.status.completed)} onClick={() => run(pick ? 'transfer' : 'assign')}>{pick ? 'Takımını değiştir' : 'Ata'}</button>{pick && <button disabled={saving || stale} onClick={() => run('remove')}>Seçimi kaldır</button>}</div>
  </DraftDialog>;
}
