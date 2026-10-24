// @vitest-environment jsdom

/**
 * Getting a position on a real handset.
 *
 * This is a regression suite for a defect found on a physical Android phone:
 * a red Next.js error overlay appeared during ordinary rider use, with a call
 * stack of `logFromNative` <- `returnResult` <- `androidBridge.onmessage`.
 *
 * That stack is Capacitor's bridge reporting a *failed plugin result*. The
 * bridge writes every failure to `console.error` before it rejects the promise
 * the app is awaiting, so a handled rejection still reaches the development
 * overlay. The overlay was therefore a symptom: the real fault was that
 * `getCurrentPosition` was being asked for a brand-new high-accuracy reading
 * every twenty seconds with ten seconds to produce one, which a phone indoors
 * frequently cannot do. Each failure also cost a position report, and a rider
 * who stops reporting is dropped from dispatch as `location_stale`.
 *
 * What is asserted here is the behaviour that prevents it: a recent cached
 * reading is acceptable, a failed attempt falls back rather than giving up,
 * and the time the reading was actually taken is carried through rather than
 * being replaced with "now".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getFix } from './geolocation';

interface PositionShape {
  coords: { latitude: number; longitude: number; accuracy?: number };
  timestamp?: number;
}

/** Install a fake Capacitor shell, as the Android WebView would. */
function installShell(getCurrentPosition: (options?: unknown) => Promise<PositionShape>): void {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { Geolocation: { getCurrentPosition } },
  };
}

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

const position = (over: Partial<PositionShape> = {}): PositionShape => ({
  coords: { latitude: 6.43, longitude: 3.42, accuracy: 12 },
  timestamp: Date.parse('2026-09-04T10:00:00.000Z'),
  ...over,
});

describe('getFix on the Android shell', () => {
  it('leads with a request the device can answer without timing out', async () => {
    const getCurrentPosition = vi.fn<(options?: unknown) => Promise<PositionShape>>(async () =>
      position(),
    );
    installShell(getCurrentPosition);

    await getFix();

    // The routine cycle must not demand a GPS-grade fix. On a handset that
    // returned +-92-100m network readings through an entire real delivery,
    // asking for high accuracy bought nothing and cost 20s timeouts — each of
    // which Capacitor writes to console.error before rejecting.
    const options = getCurrentPosition.mock.calls[0]?.[0] as { enableHighAccuracy?: boolean };
    expect(options.enableHighAccuracy).toBe(false);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('escalates when the platform repeats the reading already reported', async () => {
    const first = Date.parse('2026-09-04T10:00:00.000Z');
    const getCurrentPosition = vi
      .fn<(options?: unknown) => Promise<PositionShape>>()
      .mockResolvedValueOnce(position({ timestamp: first }))
      .mockResolvedValueOnce(position({ timestamp: first + 30_000 }));
    installShell(getCurrentPosition);

    const result = await getFix('2026-09-04T10:00:00.000Z');

    // A repeated reading cannot move the server's freshness clock, so the
    // cache must be refused rather than the duplicate reported.
    const escalation = getCurrentPosition.mock.calls[1]?.[0] as { maximumAge?: number };
    expect(escalation.maximumAge).toBe(0);
    expect(result.fix?.takenAt).toBe('2026-09-04T10:00:30.000Z');
    expect(result.duplicate).toBeUndefined();
  });

  it('returns no reportable position when no newer reading exists', async () => {
    const at = Date.parse('2026-09-04T10:00:00.000Z');
    const getCurrentPosition = vi
      .fn<(options?: unknown) => Promise<PositionShape>>()
      .mockResolvedValueOnce(position({ timestamp: at }))
      .mockRejectedValueOnce(
        Object.assign(new Error('Could not obtain location in time.'), {
          code: 'OS-PLUG-GLOC-0010',
        }),
      );
    installShell(getCurrentPosition);

    const result = await getFix('2026-09-04T10:00:00.000Z');

    // The reading exists, but its timestamp is one the server already holds.
    // Submitting it would look like a report while the rider ages towards
    // `location_stale` and silently drops out of dispatch. So it is withheld
    // as a failure rather than flagged as a caveat: there is no position here
    // for a caller to send by mistake.
    expect(result.duplicate).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.fix).toBeUndefined();
  });

  it('never exposes the already-reported timestamp as a fresh position', async () => {
    // The specific accident this guards: a caller reading `result.fix` without
    // checking `duplicate`, and posting a sensor timestamp the server has seen
    // before. There must be nothing there to read.
    const at = Date.parse('2026-09-04T10:00:00.000Z');
    installShell(
      vi
        .fn<(options?: unknown) => Promise<PositionShape>>()
        .mockResolvedValueOnce(position({ timestamp: at }))
        .mockRejectedValueOnce(new Error('no fresh reading')),
    );

    const result = await getFix('2026-09-04T10:00:00.000Z');

    expect(result.fix?.takenAt).toBeUndefined();
    expect(result.fix?.latitude).toBeUndefined();
    // And the reason survives, so the diagnostics panel can explain the pause.
    expect(result.error).toContain('no new reading since 2026-09-04T10:00:00.000Z');
  });

  it('still returns a position when the reading is not a repeat', async () => {
    // The ordinary cycle must be untouched by the duplicate rule: a caller
    // passing the previous timestamp and getting a different reading back gets
    // a usable position on the first attempt, with no escalation.
    const getCurrentPosition = vi.fn<(options?: unknown) => Promise<PositionShape>>(async () =>
      position({ timestamp: Date.parse('2026-09-04T10:00:30.000Z') }),
    );
    installShell(getCurrentPosition);

    const result = await getFix('2026-09-04T10:00:00.000Z');

    expect(result.ok).toBe(true);
    expect(result.duplicate).toBeUndefined();
    expect(result.fix?.takenAt).toBe('2026-09-04T10:00:30.000Z');
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('accepts a recently cached reading instead of forcing a new acquisition', async () => {
    const getCurrentPosition = vi.fn<(options?: unknown) => Promise<PositionShape>>(async () =>
      position(),
    );
    installShell(getCurrentPosition);

    await getFix();

    // `maximumAge: 0` — the plugin's default when the option is absent — is
    // what made the call time out indoors. It must be sent, and non-zero.
    const options = getCurrentPosition.mock.calls[0]?.[0] as { maximumAge?: number; timeout?: number };
    expect(options.maximumAge).toBeGreaterThan(0);
    // And still inside the server's 120s freshness rule, which is not relaxed.
    expect(options.maximumAge).toBeLessThan(120_000);
    expect(options.timeout).toBeGreaterThan(10_000);
  });

  it('reports when the reading was taken, not when it was requested', async () => {
    installShell(async () => position({ timestamp: Date.parse('2026-09-04T10:00:00.000Z') }));

    const result = await getFix();

    expect(result.ok).toBe(true);
    expect(result.fix?.takenAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('falls back to a coarse reading rather than reporting no position at all', async () => {
    const getCurrentPosition = vi
      .fn<(options?: unknown) => Promise<PositionShape>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('Could not obtain location in time. Try with a higher timeout.'), {
          code: 'OS-PLUG-GLOC-0010',
        }),
      )
      .mockResolvedValueOnce(position({ coords: { latitude: 6.43, longitude: 3.42, accuracy: 100 } }));
    installShell(getCurrentPosition);

    const result = await getFix();

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.fix?.accuracy).toBe(100);
    const escalation = getCurrentPosition.mock.calls[1]?.[0] as { enableHighAccuracy?: boolean };
    expect(escalation.enableHighAccuracy).toBe(true);
  });

  it('keeps the plugin error code when both attempts fail', async () => {
    installShell(async () => {
      throw Object.assign(new Error('Location services are not enabled.'), {
        code: 'OS-PLUG-GLOC-0007',
      });
    });

    const result = await getFix();

    expect(result.ok).toBe(false);
    expect(result.source).toBe('native');
    // The code is what identifies the failure without a laptop attached to the
    // handset, so it must survive into the on-screen diagnostics.
    expect(result.error).toContain('OS-PLUG-GLOC-0007');
    expect(result.error).toContain('Location services are not enabled.');
  });

  it('never rejects, so a failure cannot become an unhandled promise', async () => {
    installShell(async () => {
      throw new Error('boom');
    });

    await expect(getFix()).resolves.toMatchObject({ ok: false });
  });
  it('refuses a reading the platform would not timestamp', async () => {
    // The whole point of requiring `takenAt`. A position with no sensor time
    // cannot be reported truthfully, and the only way to report it at all
    // would be to substitute the current time — which would renew the rider's
    // freshness against a reading of unknown age and feed the anti-spoofing
    // check a speed derived from an interval that never happened.
    installShell(async () => ({
      coords: { latitude: 6.43, longitude: 3.42, accuracy: 12 },
      // no `timestamp`
    }));

    const result = await getFix();

    expect(result.ok).toBe(false);
    expect(result.fix).toBeUndefined();
    expect(result.error).toContain('no timestamp');
  });

  it('never invents a timestamp for a successful fix', async () => {
    // Belt and braces against the fallback that used to live at the call site
    // (`result.fix.takenAt ?? new Date().toISOString()`): every position this
    // module hands back carries the platform's own time, and one that cannot
    // is not handed back at all.
    const at = Date.parse('2026-09-04T10:00:00.000Z');
    installShell(async () => position({ timestamp: at }));

    const result = await getFix();

    expect(result.fix?.takenAt).toBe('2026-09-04T10:00:00.000Z');
    expect(Date.parse(result.fix?.takenAt ?? '')).toBe(at);
    // Not "now" under any circumstances.
    expect(Math.abs(Date.now() - Date.parse(result.fix?.takenAt ?? ''))).toBeGreaterThan(1000);
  });
});
