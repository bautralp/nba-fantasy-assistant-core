import { useState } from 'react';
import { useWorkspace } from '../../app/WorkspaceContext';
import { CATEGORY_TARGETS, NINE_CATEGORIES, type CategoryTargets } from '../../domain/models/categories';
import { applyDraftCommand } from '../../application/draftCommands';
import { DraftDialog } from './DraftDialog';
import { initialDialogTargets } from './strategyDefaults';
const labels = { unset: 'Belirlenmedi', top1: 'İlk 1', top3: 'İlk 3', top5: 'İlk 5', top7: 'İlk 7', punt: 'Punt' };
export function StrategyDialog({ targets, onClose, onSuccess }: { targets: CategoryTargets; onClose: () => void; onSuccess: (message: string) => void }) {
  const { workspace, revision, saving, store } = useWorkspace();
  const [initial] = useState(() => initialDialogTargets(targets));
  const [openedRevision] = useState(revision), [values, setValues] = useState<CategoryTargets>(initial.values), [error, setError] = useState('');
  return <DraftDialog title="Kategori hedefleri" onClose={onClose}>
    <p>{workspace?.teams.find(t => t.id === workspace.league.userTeamId)?.name} · Her kategori bağımsızdır.</p>
    <p className="muted">İlk 1/3/5/7, ulaşmak istediğiniz lig sırasıdır; mevcut sıranız değildir. Belirlenmedi hedef oluşturmaz. Punt, kategoriyi hedef ve öneri ağırlığı dışında bırakır. {initial.suggested ? '' : 'Seçili değerler geçerli hedeflerinizi gösterir; '}Değişiklikler yalnızca Hedefleri uygula ile belleğe kaydedilir. İptal değişiklikleri bırakır.</p>
    {initial.suggested && <p className="notice">Henüz hedef belirlenmedi; başlangıç önerisi olarak tüm kategoriler İlk 5 seçili geldi. İstediğin kategorileri değiştirip Hedefleri uygula’ya bas.</p>}
    <div className="form-grid">{NINE_CATEGORIES.map(c => <label key={c}>{c}<select aria-label={c} value={values[c]} onChange={e => setValues(p => ({ ...p, [c]: e.target.value }))}>{CATEGORY_TARGETS.map(t => <option key={t} value={t}>{labels[t]}</option>)}</select></label>)}</div>
    {revision !== openedRevision && <p role="alert">Çalışma alanı değişti. Stratejiyi yeniden açın.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="actions"><button disabled={saving || revision !== openedRevision} className="primary" onClick={() => {
      try {
        const current = store.getSnapshot();
        if (!current.workspace || current.revision !== openedRevision) throw new Error('Çalışma alanı değişti.');
        if (!store.accept(applyDraftCommand(current.workspace, { kind: 'strategy', targets: values }))) throw new Error('Hedefler uygulanamadı.');
        onSuccess('Kategori hedefleri belleğe uygulandı. Kalıcı kayıt için Kaydet’i kullanın.'); onClose();
      } catch (e) { setError(e instanceof Error ? e.message : 'İşlem uygulanamadı.'); }
    }}>Hedefleri uygula</button><button onClick={onClose}>İptal</button></div>
  </DraftDialog>;
}
