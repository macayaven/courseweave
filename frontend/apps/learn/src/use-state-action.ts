import { useEffect, useRef, useState } from "react";
import type { StateOperation } from "./api";

export interface StateActionProps {
  onStateOperation?(
    operation: StateOperation,
    signal?: AbortSignal,
  ): Promise<void>;
  onRefresh?(): Promise<void>;
  recovery?: boolean;
  onRecovery?(): void;
}
/** A direct learner action is never automatically replayed after a conflict. */
export function useStateAction({
  onStateOperation,
  onRefresh,
  recovery = false,
  onRecovery,
}: StateActionProps) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const flight = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      flight.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (recovery) {
      flight.current?.abort();
      flight.current = null;
      setPending(false);
    }
  }, [recovery]);
  async function submit(
    operation: StateOperation,
    success = "Response saved.",
  ) {
    if (recovery || flight.current || !onStateOperation) return false;
    const controller = new AbortController();
    flight.current = controller;
    setPending(true);
    setNotice(null);
    try {
      await onStateOperation(operation, controller.signal);
      if (!alive.current || controller.signal.aborted) return false;
      setNotice(success);
      return true;
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return false;
      const failure = error as { status?: number; code?: string };
      if (failure.status === 409 || failure.code === "revision_mismatch") {
        try {
          if (!onRefresh) throw Error();
          await onRefresh();
          if (alive.current && !controller.signal.aborted)
            setNotice("State changed; review the refreshed course state.");
        } catch {
          if (alive.current && !controller.signal.aborted) {
            onRecovery?.();
            setNotice("State refresh failed. Reconnect to continue.");
          }
        }
      } else {
        if (failure.status === 401 || failure.status === 403) onRecovery?.();
        setNotice("Your response could not be saved. Review and try again.");
      }
      return false;
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (alive.current) setPending(false);
      }
    }
  }
  return {
    submit,
    pending,
    notice,
    disabled: recovery || pending || !onStateOperation,
  };
}
