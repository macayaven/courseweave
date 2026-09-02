import { Button } from '@courseweave/ui';
import { useState } from 'react';

export function ReconnectPanel({ hasDraft, onReconnect }: { hasDraft: boolean; onReconnect(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  return <section aria-label="Reconnect teacher"><h2>Reconnect to CourseWeave</h2>{hasDraft ? <p>Your draft is unsent.</p> : null}<Button type="button" disabled={pending} onClick={() => { setPending(true); void onReconnect().finally(() => setPending(false)); }}>Reconnect</Button></section>;
}
