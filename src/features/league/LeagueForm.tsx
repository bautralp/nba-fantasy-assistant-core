import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { applyLeagueSettings, blankLeagueSettings, settingsFromWorkspace, type FieldErrors, type LeagueSettings } from '../../application/leagueSetup';
import { useWorkspace } from '../../app/WorkspaceContext';
import { INITIAL_LEAGUE_RULES, totalDraftPicks } from '../../domain/rules/leagueRules';
import { snakeTeamAt } from '../../domain/rules/draftRules';

export function LeagueForm({ onClose, initial, notice }: { onClose?: () => void; initial?: LeagueSettings; notice?: ReactNode }) {
  const { workspace, store, saving } = useWorkspace();
  const [form, setForm] = useState<LeagueSettings>(() => workspace ? settingsFromWorkspace(workspace) : initial ?? { ...blankLeagueSettings(), season: '2026-27' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const locked = !!workspace && (!workspace.draftSession || workspace.draftSession.status !== 'setup' || workspace.draftSession.picks.length > 0);
  const change = (patch: Partial<LeagueSettings>) => setForm(previous => ({ ...previous, ...patch }));
  const move = (id: string, position: number) => {
    if (locked) return;
    const order = form.draftOrder.filter(teamId => teamId !== id);
    order.splice(position, 0, id);
    change({ draftOrder: order });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = applyLeagueSettings(form, store.getSnapshot().workspace);
    if (!result.ok) {
      setErrors(result.error);
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    if (store.accept(result.value)) { void store.save(); onClose?.(); }
  };
  const fieldError = (key: string) => errors[key] ? <span className="field-error" id={`error-${key}`}>{errors[key]}</span> : null;
  const attrs = (key: string) => ({ 'aria-labelledby': `label-${key}`, 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `error-${key}` : undefined });
  const rules = INITIAL_LEAGUE_RULES;
  return <section className="panel" aria-labelledby="setup-heading">
    <h2 id="setup-heading" tabIndex={-1}>{workspace ? 'Lig bilgilerini düzenle' : 'Ligini oluştur'}</h2>
    {notice}
    <p className="muted">{rules.teamCount} takım · {rules.rosterSize} oyuncu · Snake draft · {rules.categories.length} kategori · {totalDraftPicks(rules)} seçim</p>
    <form ref={formRef} onSubmit={submit} noValidate>
      <fieldset disabled={saving}>
        <div className="form-grid">
          <label><span id="label-name">Lig adı</span><input autoComplete="off" value={form.name} onChange={event => change({ name: event.target.value })} {...attrs('name')} />{fieldError('name')}</label>
          <p className="season-label">Sezon: {form.season}</p>
          <label><span id="label-userTeamId">Kendi takımın</span><select value={form.userTeamId} onChange={event => change({ userTeamId: event.target.value })} {...attrs('userTeamId')}>
            <option value="">Takım seçin</option>{form.teams.map((team, index) => <option key={team.id} value={team.id}>{team.name.trim() || `Takım alanı ${index + 1}`}</option>)}
          </select>{fieldError('userTeamId')}</label>
        </div>
        <p className="muted">Takımını değiştirmek analiz odağını değiştirir; mevcut seçimlerin sahipliği korunur.</p>
        {form.userTeamId && <p>Draft pozisyonun: {form.draftOrder.indexOf(form.userTeamId) + 1}</p>}
        <h3>Takımlar ve ilk tur sırası</h3>
        <p id="order-help" className="muted">{locked ? 'Draft başladığı veya draft oturumu bulunmadığı için sıra değiştirilemez. Mevcut seçimler korunur.' : 'Yukarı/aşağı butonlarıyla sırayı düzenleyin. İkinci tur ters sırada ilerler.'}</p>
        {fieldError('teams')}{fieldError('draftOrder')}
        <ol className="team-list">
          {form.draftOrder.map((id, position) => {
            const team = form.teams.find(item => item.id === id)!;
            const fieldIndex = form.teams.findIndex(item => item.id === id) + 1;
            return <li key={id} className="team-row">
              <span className="order-number" aria-label={`Draft sırası ${position + 1}`}>{position + 1}</span>
              <label><span id={`label-${id}`}>Takım {fieldIndex} adı</span><input value={team.name} onChange={event => change({ teams: form.teams.map(item => item.id === id ? { ...item, name: event.target.value } : item) })} {...attrs(id)} />{fieldError(id)}</label>
              <div className="move-buttons"><button type="button" aria-label={`Takım ${fieldIndex} yukarı taşı`} disabled={locked || position === 0} onClick={() => move(id, position - 1)}>↑</button><button type="button" aria-label={`Takım ${fieldIndex} aşağı taşı`} disabled={locked || position === form.teams.length - 1} onClick={() => move(id, position + 1)}>↓</button></div>
            </li>;
          })}
        </ol>
        <details><summary>İkinci tur sırasını gör</summary><ol className="round-preview">{form.draftOrder.map((_, index) => {
          const id = snakeTeamAt(form.draftOrder, rules.teamCount + index, rules);
          return <li key={index}>{form.teams.find(team => team.id === id)?.name || 'İsimsiz takım'}</li>;
        })}</ol></details>
        {errors.integrity && <p role="alert" className="field-error">{errors.integrity}</p>}
        {Object.keys(errors).length > 0 && <p role="alert" className="field-error">İşaretli alanları düzeltin. Kayıt yapılmadı.</p>}
        <div className="actions"><button className="primary" type="submit">{workspace ? 'Değişiklikleri kaydet' : 'Lig oluştur ve kaydet'}</button>{onClose && <button type="button" onClick={onClose}>Vazgeç</button>}</div>
      </fieldset>
    </form>
  </section>;
}
