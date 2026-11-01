import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './shared/styles.css';
import { isSyntheticDemo } from './publicCore/dataAccess.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <aside role="note" style={{padding:16,borderBottom:"2px solid currentColor"}}>{isSyntheticDemo() ? "SENTETİK DEMO — gerçek ESPN/NBA verisi veya bilimsel tahmin değildir. Lig ID: 789. Actual geçmiş istatistikleri bu demoda yoktur." : <>Public Core — canlı veri ve production yayını bu dağıtımda yok. <a href="?demo=synthetic">Sentetik demoyu aç</a></>}</aside>
    <App />
  </StrictMode>,
);
