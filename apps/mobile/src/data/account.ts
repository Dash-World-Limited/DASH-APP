/**
 * The signed-in person's own details, read and edited through the API. The
 * server holds the only copy; nothing here caches it.
 */

import type { ApiClient } from '../api/client';
import type { AccountProfile, PersonalDetailsChanges, ProfileEditable } from '../features/personalDetails';

export async function getAccountProfile(api: ApiClient): Promise<{ profile: AccountProfile; editable: ProfileEditable }> {
  return api.request<{ profile: AccountProfile; editable: ProfileEditable }>('/v1/account/profile');
}

export async function saveProfileFields(api: ApiClient, fields: PersonalDetailsChanges['profile']): Promise<void> {
  await api.request('/v1/account/profile', { method: 'PATCH', body: fields });
}

/** The phone keeps its own route, with its own checks. */
export async function savePhone(api: ApiClient, phone: string): Promise<void> {
  await api.request('/v1/account/phone', { method: 'PATCH', body: { phone } });
}
