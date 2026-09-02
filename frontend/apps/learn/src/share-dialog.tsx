import { Button } from '@courseweave/ui';
import { useEffect, useId, useRef, useState } from 'react';

export type ShareKind = 'selection' | 'cell' | 'output' | 'text';

export function ShareDialog({ maxChars, allowedKinds, onCancel, onConfirm, restoreFocus }: { maxChars: number; allowedKinds: ShareKind[]; onCancel(): void; onConfirm(value: { kind: ShareKind; content: string; label?: string }): Promise<void>; restoreFocus?(): void }) {
  const [kind, setKind] = useState<ShareKind>(allowedKinds[0] ?? 'text');
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const titleId = useId();
  const descriptionId = useId();
  const count = Array.from(content).length;
  const valid = allowedKinds.includes(kind) && count <= maxChars && count > 0;
  useEffect(() => { select.current?.focus(); }, []);
  const restore = () => { restoreFocus?.() ?? previousFocus.current?.focus(); };
  useEffect(() => () => restore(), []);
  const cancel = () => {
    onCancel();
    queueMicrotask(restore);
  };
  return <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={(event) => { if (event.key === 'Escape' && !pending) { event.preventDefault(); cancel(); } if (event.key === 'Tab') { const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('select, textarea, button:not([disabled])') ?? []); const first = items[0]; const last = items.at(-1); if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); } } }}><h2 id={titleId}>Share with teacher</h2><p id={descriptionId}>This is shared with the provider for one run only and is not saved to conversation history or proposals.</p><label>Share kind<select ref={select} value={kind} onChange={(event) => setKind(event.target.value as ShareKind)}>{allowedKinds.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Share content<textarea value={content} onChange={(event) => setContent(event.target.value)} /></label><p>{count} / {maxChars} characters</p><Button type="button" onClick={cancel} disabled={pending}>Cancel</Button><Button type="button" disabled={!valid || pending} onClick={() => { setPending(true); void onConfirm({ kind, content }).finally(() => setPending(false)); }}>Share and ask</Button></section>;
}
