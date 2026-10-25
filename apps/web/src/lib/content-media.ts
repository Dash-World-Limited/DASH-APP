import { API_BASE } from './api';

/** Accept private storage URLs and the existing local signed-file contract. */
export function contentImageUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !(/^https?:\/\//.test(value) || value.startsWith('/v1/files/'))
  )
    return null;
  try {
    const url = new URL(value, API_BASE);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
