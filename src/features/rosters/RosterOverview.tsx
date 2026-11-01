import type { AnalysisView } from '../../application/analysisSelectors';
type RosterPlayer = NonNullable<AnalysisView['rosters'][number]['slots'][number]['player']>;
function Player({ player, onPlayer }: { player: RosterPlayer; onPlayer: (id: string) => void }) {
  return <div className="roster-player"><button className="player-link" onClick={() => onPlayer(player.playerId)}>{player.name}</button><small>{player.positions.join('/') || 'Pozisyon bilinmiyor'}</small>{player.warning && <small className="field-error">{player.warning}</small>}</div>;
}
export function RosterOverview({ analysis, onPlayer }: { analysis: AnalysisView; onPlayer: (id: string) => void }) {
  return <section className="panel analysis-section" aria-label="Takım kadroları"><details open><summary><h2>Takım kadroları</h2></summary>
    <p className="muted">Yerleşimler motor tarafından hesaplanır. Oyuncu adına basarak mevcut atama penceresini açabilirsiniz.</p>
    <div className="roster-grid">{analysis.rosters.map(t => <details open className={`team-roster ${t.isMine ? 'my-team' : ''}`} key={t.id} data-team-id={t.id}>
      <summary><strong>{t.name}</strong>{t.isMine && <span> · Benim takımım</span>}<small>Draft sırası {t.draftPosition || '—'} · {t.count}/13 oyuncu · {t.rated} geçerli projeksiyon</small></summary>
      <ul className="roster-slots">{t.slots.map(s => <li key={s.index} data-slot={s.slot}><span className="slot-label">{s.slot}</span>{s.player ? <Player player={s.player} onPlayer={onPlayer} /> : <span className="muted">Boş</span>}</li>)}</ul>
      {t.unplaced.length > 0 && <div className="unplaced"><p className="notice">Uygun boş slot bulunamayan oyuncular (takım sahipliği korunur):</p>{t.unplaced.map(p => <Player key={p.playerId} player={p} onPlayer={onPlayer} />)}</div>}
      {t.lineup.unknown > 0 && <p className="muted">{t.lineup.unknown} oyuncunun pozisyonu bilinmiyor; zorunlu slot uygunluğu doğrulanamıyor.</p>}
    </details>)}</div>
  </details></section>;
}
