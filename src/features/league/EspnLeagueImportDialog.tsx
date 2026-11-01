import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DraftDialog } from '../draft/DraftDialog';
import { createEspnClient } from '../../infrastructure/espn/client';
import { checkDraftSupport, espnImportError, ESPN_DRAFT_SEASON, type DraftSupport } from '../../application/espnLeagueImport';
import './espnLeagueImport.css';

type Loader = Pick<ReturnType<typeof createEspnClient>, 'load'>;
let sharedClient: Loader | null = null;
const defaultLoader = () => (sharedClient ??= createEspnClient());

/** Read-only ESPN lookup. It never writes to ESPN and never creates the league by itself. */
export function EspnLeagueImportDialog({ onImported, onManual, onClose, loader = defaultLoader }: {
  onImported: (support: Extract<DraftSupport, { ok: true }>) => void; onManual: () => void; onClose: () => void; loader?: () => Loader;
}) {
  const [input, setInput] = useState(''), [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<{ title: string; reasons: readonly string[] } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setProblem(null);
    try {
      const league = await loader().load(input, ESPN_DRAFT_SEASON.espnSeasonId, { signal: controller.signal });
      if (request.current !== controller) return;
      const support = checkDraftSupport(league);
      if (support.ok) onImported(support);
      else setProblem({ title: `“${league.name}” bu ayarlarla otomatik aktarılamıyor:`, reasons: support.reasons });
    } catch (error) {
      if (request.current !== controller) return;
      const message = espnImportError(error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined);
      if (message) setProblem({ title: 'Lig getirilemedi.', reasons: [message] });
    } finally { if (request.current === controller) setLoading(false); }
  };
  return <DraftDialog title="Ligini oluştur" onClose={() => { request.current?.abort(); onClose(); }}>
    <form className="espn-import" onSubmit={submit} noValidate>
      <label>ESPN lig ID’si<input inputMode="numeric" autoComplete="off" value={input} disabled={loading} aria-describedby="espn-import-note" aria-invalid={!!problem}
        onChange={e => { setInput(e.target.value); setProblem(null); }} placeholder="Örn. 12345678" /></label>
      <p id="espn-import-note" className="espn-import-note">Şimdilik yalnız 10 takımlı, takım başına 13 oyunculu ve 9 kategorili ESPN ligleri otomatik aktarılabiliyor. Farklı ayarlı ligler için bilgileri kendin girebilirsin. Lig herkese açık (public) olmalı.</p>
      {loading && <p role="status">ESPN’den lig bilgileri alınıyor…</p>}
      {problem && <div role="alert" className="espn-import-problem"><p><strong>{problem.title}</strong></p><ul>{problem.reasons.map(r => <li key={r}>{r}</li>)}</ul>
        <button type="button" className="primary" onClick={onManual}>Lig bilgilerini kendim gireceğim</button></div>}
      <div className="actions">
        <button type="submit" className="primary" disabled={loading || !input.trim()}>{loading ? 'Getiriliyor…' : 'Ligi ESPN’den getir'}</button>
        {!problem && <button type="button" onClick={onManual}>Lig bilgilerini kendim gireceğim</button>}
      </div>
    </form>
  </DraftDialog>;
}
