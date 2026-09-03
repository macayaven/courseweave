import { Button } from '@courseweave/ui';
import { useEffect, useId, useRef, useState } from 'react';

export type ShareKind = 'selection' | 'cell' | 'output' | 'text';
export type CapturedShare = { kind: Exclude<ShareKind, 'text'>; content: string; label?: string };

export function ShareDialog({ maxChars, allowedKinds, onCancel, onConfirm, onCapture, restoreFocus }: { maxChars: number; allowedKinds: ShareKind[]; onCancel(): void; onConfirm(value: { kind: ShareKind; content: string; label?: string }): Promise<void>; onCapture?(kind: Exclude<ShareKind, 'text'>, maxChars: number): Promise<CapturedShare>; restoreFocus?(): void }) {
  const [kind, setKind] = useState<ShareKind>(allowedKinds[0] ?? 'text');
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const titleId = useId();
  const descriptionId = useId();
  const count = Array.from(content).length;
  const valid = allowedKinds.includes(kind) && (kind === 'text' ? count <= maxChars && count > 0 : onCapture !== undefined);
  useEffect(() => { select.current?.focus(); }, []);
  const restore = () => { restoreFocus?.() ?? previousFocus.current?.focus(); };
  useEffect(() => () => restore(), []);
  const cancel = () => {
    onCancel();
    queueMicrotask(restore);
  };
  const confirm = async () => {
    if (!valid) return;
    setPending(true);
    setNotice(null);
    try {
      if (kind === 'text') {
        await onConfirm({ kind, content, label: undefined });
        return;
      }
      let captured: CapturedShare | null = await onCapture!(kind, maxChars);
      if (captured.kind !== kind || Array.from(captured.content).length === 0 || Array.from(captured.content).length > maxChars) throw new Error('invalid_capture');
      const confirmation = onConfirm(captured);
      captured = null;
      await confirmation;
    } catch {
      setNotice('Could not capture that content. Nothing was shared.');
    } finally {
      setPending(false);
    }
  };
  return <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={(event) => { if (event.key === 'Escape' && !pending) { event.preventDefault(); cancel(); } if (event.key === 'Tab') { const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('select, textarea, button:not([disabled])') ?? []); const first = items[0]; const last = items.at(-1); if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); } } }}><h2 id={titleId}>Share with teacher</h2><p id={descriptionId}>This is shared with the provider for one run only and is not saved to conversation history or proposals. Maximum {maxChars} characters.</p><label>Share kind<select ref={select} value={kind} onChange={(event) => { setKind(event.target.value as ShareKind); setContent(''); setNotice(null); }}>{allowedKinds.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>{kind === 'text' ? <><label>Share content<textarea value={content} onChange={(event) => setContent(event.target.value)} /></label><p>{count} / {maxChars} characters</p></> : null}{notice ? <p role="status">{notice}</p> : null}<Button type="button" onClick={cancel} disabled={pending}>Cancel</Button><Button type="button" disabled={!valid || pending} onClick={() => void confirm()}>Share and ask</Button></section>;
}
