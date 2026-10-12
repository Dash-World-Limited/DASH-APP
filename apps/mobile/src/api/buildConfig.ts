/**
 * Build-time values that must survive into the standalone native bundle.
 *
 * CI rewrites this file in its workspace before typecheck/prebuild. Keeping a
 * checked-in null placeholder makes local development explicit while avoiding
 * reliance on Expo Constants for the one value that decides whether the app can
 * reach DASH at all.
 */
export const COMPILED_API_URL: string | null = null;
