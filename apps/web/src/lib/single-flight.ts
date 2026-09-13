'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Run an async job when it becomes needed, one at a time, and report progress.
 *
 * Written because the obvious inline version has a trap that cost a physical
 * test. If the "in progress" flag is React state *and* appears in the effect's
 * own dependency list, setting it re-runs the effect; React first invokes the
 * previous run's cleanup, and if the reset is guarded by that cleanup's
 * `cancelled` flag — which looks like ordinary hygiene — the in-flight job
 * reaches its `finally`, sees `cancelled`, and never clears the flag.
 *
 * The flag then stays true for the life of the screen. On the rider screen that
 * meant the accept button was permanently disabled: a rider was woken by a
 * push, watched a ninety-second offer expire, and could not press the only
 * button that mattered.
 *
 * So re-entry is guarded by a ref, which does not re-trigger the effect, and
 * the reset is unconditional. An interrupted job must still leave the UI
 * reachable — being wrong about whether a job finished is recoverable, being
 * stuck "in progress" for ever is not.
 */
export function useSingleFlight(needed: boolean, run: () => Promise<void>): boolean {
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  // Held in a ref so a changing callback identity cannot restart the job.
  const latest = useRef(run);
  latest.current = run;

  useEffect(() => {
    if (!needed || inFlight.current) return;

    inFlight.current = true;
    setRunning(true);
    void (async () => {
      try {
        await latest.current();
      } catch {
        // The job reports its own failures — the rider screen's job surfaces a
        // failed fix through its readiness state. This hook owns one thing,
        // whether a job is in flight, and a rejection is still an end.
        //
        // Without this the reset below still ran, but the rejection escaped
        // the `void`-ed promise as an unhandled rejection: in the Android
        // WebView, a console error and a development overlay every time a
        // rider woke without signal.
      } finally {
        inFlight.current = false;
        setRunning(false);
      }
    })();
  }, [needed]);

  return running;
}
