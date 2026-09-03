import { useEffect } from 'react';

export type RecoveryStatus = 'connected' | 'reconnecting' | 'disconnected' | 'conflict';

/** Browsers only receive a warning; no unload write, beacon, storage, or replay occurs. */
export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
