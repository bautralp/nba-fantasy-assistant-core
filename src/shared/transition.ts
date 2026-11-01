import { flushSync } from 'react-dom';
/** Browser snapshots animate the presentation without remounting live React state. */
export function transition(update: () => void) {
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const animation = document.startViewTransition(() => flushSync(update));
    // Rapid navigation can legitimately skip a pending snapshot.
    void animation.ready.catch(() => {});
  } else update();
}
