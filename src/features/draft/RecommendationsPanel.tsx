import type { WorkspaceSnapshot } from '../../domain/models/workspace';
import type { DraftView } from '../../application/draftSelectors';
export function RecommendationsPanel({ workspace: w, view: v, onPlayer }: { workspace: WorkspaceSnapshot; view: DraftView; onPlayer: (id: string) => void }) {
  return <aside className="panel recommendations-panel" aria-labelledby="recommendations-heading">
    <h2 id="recommendations-heading">Öneriler</h2>
    <p className="muted">Motor puanı geçici bir değerlendirmedir.</p>
    {v.plan && v.plan.entries.length > 0 && <details className="needs-summary" open><summary>Kategori ihtiyaçları · {v.plan.stage}</summary><ul>{v.plan.entries.map(e => <li key={e.cat}>{e.cat} · {e.target} · {e.status} · Tempo açığı {e.paceGap.toFixed(2)}</li>)}</ul></details>}
    {v.empty ? <p className="notice">{v.empty}</p> : <>
      {v.topFive.length < 5 && <p className="notice">Yalnızca {v.topFive.length} uygun aday kaldı.</p>}
      <ol className="recommendation-list">{v.topFive.map((r, i) => <li key={r.playerId}>
        <div className="module-heading"><button className="player-link" onClick={() => onPlayer(r.playerId)}>{i + 1}. {w.players.find(p => p.id === r.playerId)?.name}</button><strong>{r.score.toFixed(3)}</strong></div>
        <p className="muted">{v.positions.get(r.playerId)?.join('/') || 'POS bilinmiyor'} · Pozisyon bonusu +{r.fit.bonus.toFixed(2)}</p>
        <p>{r.positive.slice(0, 3).map(c => `${c.cat} ${c.weighted.toFixed(2)}`).join(' · ') || 'Pozitif ağırlıklı kategori katkısı yok.'}</p>
        <details><summary>Detaylı gerekçe</summary><p>{r.fit.reason}</p>{r.contributions.map(c => <p className="contribution" key={c.cat}>{c.cat}: Z {c.z.toFixed(2)} · Katkı {c.weighted.toFixed(2)} · Pozitif {c.weighted > .025 ? 'evet' : 'hayır'} · {c.need} · Tempo açığı {c.paceGap.toFixed(2)} · Sıra {c.br ?? '—'} → {c.ar ?? '—'} · Kazanç {c.gain.toFixed(2)}{c.rivals.length ? ` · Rakipler: ${c.rivals.map(r => `${r.name} (${r.ahead ? 'önde' : 'yakın takipte / eşit'})`).join(', ')}` : ''}</p>)}</details>
      </li>)}</ol>
    </>}
  </aside>;
}
