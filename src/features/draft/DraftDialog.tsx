import { useEffect, useRef, type ReactNode } from 'react';

/** Native modal: top layer, inert background, focus trap, Escape and focus restoration. */
export function DraftDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (opener?.isConnected) opener.focus(); else document.getElementById('pool-heading')?.focus(); };
  }, []);
  return <dialog className="draft-dialog" ref={ref} aria-labelledby="draft-dialog-title" onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const dialog = ref.current!;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(el => el.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="module-heading"><h2 id="draft-dialog-title">{title}</h2><button onClick={onClose} aria-label="Pencereyi kapat">Kapat</button></div>
    {children}
  </dialog>;
}
