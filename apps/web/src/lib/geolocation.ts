'use client';

/**
 * Where a position comes from, and why it is not always `navigator`.
 *
 * The rider shell loads the web client from a development machine over plain
 * HTTP. Chromium refuses `navigator.geolocation` on any origin that is not a
 * secure context — https, localhost, 127.0.0.1 or file — and an IP address on
 * port 3000 is none of those. The failure is immediate and total:
 *
 *     code 1 PERMISSION_DENIED — "Only secure origins are allowed"
 *
 * It happens *before* the WebView asks Android for anything, so the Android
 * permission is never requested, `onGeolocationPermissionsShowPrompt` never
 * fires, and no amount of manifest permission changes it. A rider on a phone
 * therefore had no way to report a position at all, and dispatch could never
 * see them.
 *
 * Capacitor's Geolocation plugin goes to the native Android location APIs
 * through the bridge instead of through the web API, so the secure-origin rule
 * does not apply to it. When the app is running inside the shell that is the
 * route used; in an ordinary browser — where the origin *is* secure, because
 * it is localhost or https — `navigator.geolocation` is used exactly as before.
 *
 * Nothing here weakens a security rule. The secure-origin restriction still
 * applies to the web API; this simply stops asking the web API a question it
 * is not allowed to answer.
 */

export interface Fix {
  latitude: number;
  longitude: number;
  accuracy?: number | undefined;
  /**
   * When the platform took the reading, as an ISO string — not when we asked
   * for it.
   *
   * Required, deliberately. A cached reading is allowed (see `PRIMARY`), so
   * the two are not the same, and the server judges both freshness and
   * plausible speed by this field. If it were optional a caller could fill the
   * gap with the current time, which would renew the rider's freshness against
   * a reading that is actually minutes old — defeating the staleness rule and
   * feeding the anti-spoofing check a speed derived from a fabricated
   * interval. A reading the platform will not timestamp is therefore not a
   * position at all, and never reaches a caller.
   */
  takenAt: string;
}

/** Which path produced (or failed to produce) the fix. Diagnostic only. */
export type GeoSource = 'native' | 'web' | 'none';

export interface GeoResult {
  ok: boolean;
  source: GeoSource;
  fix?: Fix;
  /** Human-readable, and specific enough to act on. */
  error?: string;
  /** True when only the escalated request produced a position. Diagnostic only. */
  degraded?: boolean;
  /**
   * True when the platform returned the reading already reported and could not
   * be persuaded to produce a newer one.
   *
   * Always accompanied by `ok: false` and **no `fix`**. That is the point: the
   * reading exists, but reporting it would carry a sensor timestamp the server
   * has already seen, which cannot advance its freshness clock — so a rider
   * would go stale and drop out of dispatch while their app cheerfully kept
   * sending. Withholding the position makes that impossible to do by accident,
   * rather than leaving every caller to remember a convention.
   */
  duplicate?: boolean;
}

interface CapacitorPluginShape {
  checkPermissions?: () => Promise<{ location?: string; coarseLocation?: string }>;
  requestPermissions?: () => Promise<{ location?: string; coarseLocation?: string }>;
  getCurrentPosition?: (options?: {
    enableHighAccuracy?: boolean;
    timeout?: number;
    maximumAge?: number;
  }) => Promise<{
    coords: { latitude: number; longitude: number; accuracy?: number };
    timestamp?: number;
  }>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { Geolocation?: CapacitorPluginShape };
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const value = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return value ?? null;
}

/** True when running inside the Android shell rather than a plain browser. */
export function isNativeShell(): boolean {
  const cap = capacitor();
  return Boolean(cap?.isNativePlatform?.() && cap.Plugins?.Geolocation);
}

/**
 * What the bridge actually looks like from inside the page.
 *
 * Reported verbatim rather than summarised: the shell has already failed twice
 * in ways that a boolean would have hidden — once because the page was on an
 * insecure origin, and once because the bridge was never injected into it at
 * all — and each cost a round of physical testing to find.
 */
export function describeBridge(): {
  capacitor: boolean;
  platform: string;
  native: boolean;
  geolocationPlugin: boolean;
} {
  const cap = capacitor();
  return {
    capacitor: Boolean(cap),
    platform: cap?.getPlatform?.() ?? 'none',
    native: Boolean(cap?.isNativePlatform?.()),
    geolocationPlugin: Boolean(cap?.Plugins?.Geolocation),
  };
}

/** Whether the platform will even entertain a geolocation request. */
export function geolocationAvailability(): {
  secureContext: boolean;
  webApi: boolean;
  native: boolean;
} {
  return {
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    webApi: typeof navigator !== 'undefined' && 'geolocation' in navigator,
    native: isNativeShell(),
  };
}

/**
 * Ask for permission up front, natively.
 *
 * The plugin's own prompt is the Android runtime one, which is the prompt that
 * never appeared while the web API was being used.
 */
export async function ensurePermission(): Promise<{ granted: boolean; state: string }> {
  const plugin = capacitor()?.Plugins?.Geolocation;
  if (!plugin?.checkPermissions) return { granted: true, state: 'not-applicable' };

  try {
    let status = await plugin.checkPermissions();
    let state = status.location ?? status.coarseLocation ?? 'prompt';

    if (state !== 'granted' && plugin.requestPermissions) {
      status = await plugin.requestPermissions();
      state = status.location ?? status.coarseLocation ?? 'denied';
    }
    return { granted: state === 'granted', state };
  } catch (error) {
    return { granted: false, state: `error: ${String((error as Error)?.message ?? error)}` };
  }
}

/**
 * How hard to try for a position, and why these numbers.
 *
 * Two failures on real hardware shaped this. First, asking for a brand-new
 * high-accuracy reading every cycle — `maximumAge` unset, which the Android
 * plugin reads as zero — with ten seconds to produce one: a rider indoors
 * cannot always manage that, so the call rejected with
 *
 *     OS-PLUG-GLOC-0010 — "Could not obtain location in time."
 *
 * roughly as often as it succeeded, costing a position report each time and
 * leaving dispatch unable to see the rider.
 *
 * Then, after allowing a cached reading, a second and subtler one: the request
 * still led with `enableHighAccuracy`, and on a handset that was returning
 * ±92–100m network fixes throughout a real delivery, that precision was being
 * paid for in twenty-second timeouts and almost never actually obtained. Every
 * one of those timeouts is written to `console.error` by Capacitor's bridge
 * before the promise rejects, which a Next.js development build turns into a
 * full-screen overlay over a working app.
 *
 * So the routine cycle now asks for what the device actually delivers: a
 * recent reading from the fused provider, which it can almost always answer
 * immediately. Accuracy in practice is unchanged — the readings were coming
 * from the same provider either way — while the timeouts that produced both
 * the lost reports and the overlays largely stop happening.
 */
const PRIMARY = { enableHighAccuracy: false, timeout: 20_000, maximumAge: 30_000 } as const;

/**
 * Force a genuinely new reading.
 *
 * Used for the two cases a cached reading cannot serve: when the platform has
 * handed back the *same* reading we already reported — its timestamp does not
 * advance, so the server's freshness clock stops even though reports keep
 * arriving — and when the routine request failed outright. `maximumAge: 0`
 * forbids the cache, which is the whole point, and is also why this one can
 * time out where the routine request does not.
 */
const FRESH = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 } as const;

/**
 * The plugin's own message together with its error code.
 *
 * The code is the part that identifies a failure without ambiguity —
 * `OS-PLUG-GLOC-0010` is the acquisition timeout, `-0007` is location switched
 * off at the OS level, `-0003` is a refused permission — and carrying it means
 * the diagnostics panel on the rider screen can answer "why" on its own,
 * instead of a physical handset having to be wired up to a laptop to find out.
 */
function describeNativeError(error: unknown): string {
  const shape = error as { message?: string; code?: string } | null;
  const message = shape?.message ?? String(error);
  return shape?.code ? `${shape.code}: ${message}` : message;
}

/** A position, or `null` when the platform gave one without a timestamp. */
function toFix(position: {
  coords: { latitude: number; longitude: number; accuracy?: number };
  timestamp?: number;
}): Fix | null {
  if (!position.timestamp) return null;
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    takenAt: new Date(position.timestamp).toISOString(),
  };
}

/** The refusal used wherever a reading arrives without a usable timestamp. */
const UNTIMESTAMPED = 'the platform returned a position with no timestamp';

async function nativeFix(
  plugin: CapacitorPluginShape,
  options: { enableHighAccuracy: boolean; timeout: number; maximumAge: number },
): Promise<GeoResult> {
  if (!plugin.getCurrentPosition) {
    return { ok: false, source: 'native', error: 'Geolocation plugin has no getCurrentPosition.' };
  }
  try {
    const fix = toFix(await plugin.getCurrentPosition(options));
    // Not reportable: without the sensor's own time there is nothing truthful
    // to send, and the only alternative would be inventing one.
    if (!fix) return { ok: false, source: 'native', error: UNTIMESTAMPED };
    return { ok: true, source: 'native', fix };
  } catch (error) {
    return { ok: false, source: 'native', error: describeNativeError(error) };
  }
}

/**
 * One position, from whichever source this platform allows.
 *
 * `lastTakenAt` is the timestamp of the reading already reported, if any. It
 * is what lets a repeated cached reading be recognised and escalated rather
 * than silently freezing the server's view of how fresh this rider is.
 */
export async function getFix(lastTakenAt?: string): Promise<GeoResult> {
  const plugin = capacitor()?.Plugins?.Geolocation;

  if (isNativeShell() && plugin?.getCurrentPosition) {
    const primary = await nativeFix(plugin, PRIMARY);

    if (primary.ok) {
      if (!lastTakenAt || primary.fix?.takenAt !== lastTakenAt) return primary;

      // Same reading as last time: the freshness clock would not move.
      const fresh = await nativeFix(plugin, FRESH);
      if (fresh.ok) return fresh;

      // Deliberately NOT a usable position. The reading is real but its
      // timestamp is one the server already holds, so submitting it would look
      // like a report while leaving the rider ageing towards `location_stale`.
      // No `fix` is returned, so no caller can send it by mistake.
      return {
        ok: false,
        source: 'native',
        duplicate: true,
        error: `no new reading since ${lastTakenAt} (${fresh.error})`,
      };
    }

    const fresh = await nativeFix(plugin, FRESH);
    if (fresh.ok) return { ...fresh, degraded: true };

    // Both messages, because which one failed and how is the whole diagnosis.
    return {
      ok: false,
      source: 'native',
      error: `${primary.error} (retry: ${fresh.error})`,
    };
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { ok: false, source: 'none', error: 'No geolocation available on this platform.' };
  }

  return new Promise<GeoResult>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix = toFix(position);
        resolve(
          fix
            ? { ok: true, source: 'web', fix }
            : { ok: false, source: 'web', error: UNTIMESTAMPED },
        );
      },
      (error) =>
        resolve({
          ok: false,
          source: 'web',
          // The code matters: 1 on an insecure origin is the secure-context
          // refusal, and it is not a permission the user can grant.
          error: `code ${error.code} — ${error.message}`,
        }),
      {
        enableHighAccuracy: PRIMARY.enableHighAccuracy,
        timeout: PRIMARY.timeout,
        maximumAge: PRIMARY.maximumAge,
      },
    );
  });
}
