import { seasonModules } from './navigation.ts';
import type { SeasonScreen } from './navigation.ts';
export function SeasonMenu({ onOpen }: { onOpen: (screen: SeasonScreen) => void }) {
  return <div className="season-grid season-modules">{seasonModules.map(module => <button key={module.title} className="main-card" disabled={module.screen === null} onClick={() => module.screen && onOpen(module.screen)}><span className="season-icon" aria-hidden="true">{module.icon}</span><strong>{module.title}</strong>{module.screen === null && <span className="season-badge">Hazırlanıyor</span>}</button>)}</div>;
}
