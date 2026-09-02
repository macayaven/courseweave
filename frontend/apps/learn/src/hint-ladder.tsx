import { Button } from '@courseweave/ui';
import type { HintLevel } from '@courseweave/ui/courseweave-types';
import { useState } from 'react';

const LABELS = ['Show a gentle hint', 'Show the next hint', 'Show the full hint'];

export function HintLadder({ level }: { level: HintLevel }) {
  const [shown, setShown] = useState(0);
  const allowed = level === 'none' ? 0 : level === 'gentle' ? 1 : level === 'graduated' ? 2 : 3;
  const label = LABELS[Math.min(shown, LABELS.length - 1)]!;
  return <section aria-label="Hint ladder">
    <Button type="button" disabled={allowed === 0 || shown >= allowed} onClick={() => setShown((value) => value + 1)}>{label}</Button>
    {shown > 0 ? <p aria-live="polite">Hint level {shown} of {allowed}</p> : null}
  </section>;
}
