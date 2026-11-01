import type { AnalysisView } from '../../application/analysisSelectors';
import { power, rankLabel } from './analysisFormatting';
export function CategoryPowerRankings({ analysis }: { analysis: AnalysisView }) {
  return <section className="panel analysis-section" aria-label="Category Power Rankings">
    <details open><summary><h2>Category Power Rankings · İlk 5 takım</h2></summary>
      <p className="muted power-explanation">Bu sıralamalar seçilmiş oyuncuların projeksiyonlarına dayanan geçici kategori güç değerlendirmeleridir. Kesin sezon sonu sıralaması veya galibiyet olasılığı değildir.</p>
      <div className="analysis-scroll" tabIndex={0} role="region" aria-label="Dokuz kategori güç sıralaması"><div className="power-grid">
        {analysis.categories.map(c => <section className="power-category" key={c.cat} aria-label={`${c.cat} güç sıralaması`}><h3>{c.cat}</h3>
          {c.leaders.length ? <ul>{c.leaders.map(t => <li key={t.teamId} className={t.isMine ? 'my-team' : ''} data-team-id={t.teamId}>
            <span className="power-rank">{rankLabel(t.rank)}</span><span className="power-team">{t.name}{t.isMine && <small>Benim takımım</small>}</span><span className="power-score">{power(t.score)}</span>
          </li>)}</ul> : <p className="muted">Henüz puanlanabilir takım yok.</p>}
        </section>)}
      </div></div>
    </details>
  </section>;
}
