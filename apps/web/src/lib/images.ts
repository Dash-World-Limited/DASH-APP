'use client';

/**
 * Where a catalogue image comes from.
 *
 * `MenuItem.imageKey` is named for its eventual life as a *storage key* — an
 * object in the storage provider, resolved to a signed or CDN URL by a
 * resolver that does not exist yet. Development and Declutter sample data hold
 * real HTTPS URLs instead, so the app can look like itself long before the
 * upload pipeline is built.
 *
 * Consumers render these with a plain `<img>` rather than `next/image`.
 * `next/image` wants to optimise through the Next server, which means either
 * whitelisting every remote host in the config or shipping an optimiser this
 * build has no need for — and the sample URLs are stand-ins that will be
 * replaced by our own storage anyway. When images come from our own bucket,
 * that is the moment to revisit it.
 *
 * Both are supported deliberately, and the discrimination is on the value
 * rather than on a flag: a value that is already a URL is used as-is, and
 * anything else is treated as a key. When the storage resolver arrives it slots
 * into the `else` branch and every existing URL keeps working, so seeded sample
 * data does not have to be migrated on the day real uploads land.
 */

/** True when the stored value is already a fetchable URL rather than a key. */
export function isDirectImageUrl(imageKey: string | null | undefined): boolean {
  return (
    typeof imageKey === 'string' &&
    (/^https?:\/\//i.test(imageKey) || /^\/v1\/files\//i.test(imageKey))
  );
}

/**
 * A URL to render, or `null` when there is nothing to show.
 *
 * Returning null rather than a placeholder URL keeps the decision about what an
 * imageless listing looks like in the component, where the surrounding layout
 * is known.
 */
export function imageUrl(imageKey: string | null | undefined): string | null {
  if (!imageKey) return null;
  if (isDirectImageUrl(imageKey)) return imageKey;

  // Raw storage keys are never rendered. The API resolves them to either a
  // provider HTTPS URL or its own signed /v1/files/... route first.
  return null;
}
