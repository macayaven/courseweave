import { Button } from '@courseweave/ui';
import { useState } from 'react';

export type ShareKind = 'selection' | 'cell' | 'output' | 'text';

export function ShareDialog({ maxChars, allowedKinds, onCancel, onConfirm }: { maxChars: number; allowedKinds: ShareKind[]; onCancel(): void; onConfirm(value: { kind: ShareKind; content: string; label?: string }): Promise<void> }) {
  const [kind, setKind] = useState<ShareKind>(allowedKinds[0] ?? 'text');
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const valid = allowedKinds.includes(kind) && content.length <= maxChars && content.length > 0;
  return <section aria-label="Share with teacher"><h2>Share with teacher</h2><p>This is shared with the provider for one run only and is not saved to conversation history or proposals.</p><label>Share kind<select value={kind} onChange={(event) => setKind(event.target.value as ShareKind)}>{allowedKinds.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Share content<textarea value={content} onChange={(event) => setContent(event.target.value)} /></label><p>{content.length} / {maxChars} characters</p><Button type="button" onClick={onCancel} disabled={pending}>Cancel</Button><Button type="button" disabled={!valid || pending} onClick={() => { setPending(true); void onConfirm({ kind, content }).finally(() => setPending(false)); }}>Share and ask</Button></section>;
}
