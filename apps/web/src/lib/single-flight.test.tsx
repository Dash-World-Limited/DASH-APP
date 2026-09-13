// @vitest-environment jsdom

/**
 * The stuck-in-progress bug, asserted directly.
 *
 * A rider woken by a push watched a ninety-second offer expire with the accept
 * button disabled. The cause was not location, dispatch, or the notification:
 * the screen's "confirming" flag was React state listed in its own effect's
 * dependencies, so setting it re-ran the effect, React invoked the previous
 * run's cleanup first, and the in-flight job then skipped its reset because it
 * believed it had been cancelled. The flag never came back down.
 *
 * The property that matters is narrow and absolute: **the flag must always
 * come back down.**
 */

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useSingleFlight } from './single-flight';

describe('useSingleFlight', () => {
  it('always comes back down when the job finishes', async () => {
    // The regression. Previously this stayed true for ever.
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { result } = renderHook(() => useSingleFlight(true, run));

    await waitFor(() => expect(result.current).toBe(true));
    await act(async () => { resolve(); });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('comes back down even when the job throws', async () => {
    // A failed confirmation must still leave the button reachable.
    const run = vi.fn(async () => { throw new Error('gps failed'); });
    const { result } = renderHook(() => useSingleFlight(true, run));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('does not let a failed job escape as an unhandled rejection', async () => {
    // The previous test passed while the hook leaked the rejection: the reset
    // ran, and the error surfaced afterwards as an unhandled rejection that
    // vitest reported against the whole run. Listening for it directly makes
    // the leak a failure of *this* test rather than noise attributed to
    // whichever test happened to be last.
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { leaked.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = vi.fn(async () => { throw new Error('no signal'); });
      const { result } = renderHook(() => useSingleFlight(true, run));
      await waitFor(() => expect(result.current).toBe(false));
      // Let the rejection, if any, reach the process before looking.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(leaked).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('runs once, not once per render', async () => {
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { rerender } = renderHook(() => useSingleFlight(true, run));

    rerender();
    rerender();
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
  });

  it('does not restart when the callback identity changes', async () => {
    // The callback is rebuilt every render in the real screen. If that
    // restarted the job, a woken rider would re-request GPS continuously.
    let resolve!: () => void;
    const first = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { rerender } = renderHook(({ cb }) => useSingleFlight(true, cb), {
      initialProps: { cb: first as () => Promise<void> },
    });

    const second = vi.fn(async () => undefined);
    rerender({ cb: second });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await act(async () => { resolve(); });
  });

  it('does nothing until it is needed', () => {
    const run = vi.fn(async () => undefined);
    const { result } = renderHook(() => useSingleFlight(false, run));
    expect(run).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it('can run again once it is needed a second time', async () => {
    // A rider may be woken twice. The guard must not be a one-shot latch.
    const run = vi.fn(async () => undefined);
    const { rerender } = renderHook(({ needed }) => useSingleFlight(needed, run), {
      initialProps: { needed: true },
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    rerender({ needed: false });
    rerender({ needed: true });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
});
