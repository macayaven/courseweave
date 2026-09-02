import { Button } from '@courseweave/ui';
import type { HintLevel } from '@courseweave/ui/courseweave-types';
import { useEffect, useState } from 'react';

const LABELS = ['Show a gentle hint', 'Show the next hint', 'Show the full hint'];

export function HintLadder({ level }: { level: HintLevel }) {
  const [shown, setShown] = useState(0);
  const allowed = level === 'none' ? 0 : level === 'gentle' ? 1 : level === 'graduated' ? 2 : 3;
  const visible = Math.min(shown, allowed);
  useEffect(() => setShown((previous) => Math.min(previous, allowed)), [allowed]);
  const label = LABELS[Math.min(visible, LABELS.length - 1)]!;
  return <section aria-label="Hint ladder">
    <Button type="button" disabled={allowed === 0 || visible >= allowed} onClick={() => setShown((value) => Math.min(value + 1, allowed))}>{label}</Button>
    {visible > 0 ? <><p aria-live="polite">Hint level {visible} of {allowed}</p><p>Break the task into one verifiable step.</p></> : null}
  </section>;
}
