/**
 * Personal Details: what the form holds, what is wrong with it, and what
 * actually changed.
 *
 * The rules are sign-up's — the same name length, the same list of states,
 * the same phone format — so an edit can never store what sign-up would have
 * refused. Only changed fields are checked and sent: a customer from before
 * the sign-up form, who never gave a state, can still fix their name.
 *
 * Pure: tested directly.
 */

import { isNigerianState } from '@dash/domain/signup';

import { normalisePhone, PHONE_E164 } from './register';

/** `GET /v1/account/profile`. */
export interface AccountProfile {
  name: string | null;
  email: string | null;
  phone: string | null;
  phoneNotice: string | null;
  state: string | null;
  cityArea: string | null;
}

export interface ProfileEditable {
  name: boolean;
  phone: boolean;
  location: boolean;
}

export interface PersonalDetailsForm {
  name: string;
  phone: string;
  state: string;
  cityArea: string;
}

export type PersonalDetailsField = keyof PersonalDetailsForm;

export interface PersonalDetailsChanges {
  /** For `PATCH /v1/account/profile`. Empty when only the phone changed. */
  profile: { name?: string; state?: string; cityArea?: string };
  /** For the existing `PATCH /v1/account/phone`, when it changed. */
  phone?: string;
}

export function formFromProfile(profile: AccountProfile): PersonalDetailsForm {
  return {
    name: profile.name ?? '',
    phone: profile.phone ?? '',
    state: profile.state ?? '',
    cityArea: profile.cityArea ?? '',
  };
}

/** What would be sent, compared after trimming and phone normalising. */
export function personalDetailsChanges(
  initial: PersonalDetailsForm,
  form: PersonalDetailsForm,
  editable: ProfileEditable,
): PersonalDetailsChanges {
  const changes: PersonalDetailsChanges = { profile: {} };
  if (editable.name && form.name.trim() !== initial.name.trim()) changes.profile.name = form.name.trim();
  if (editable.location && form.state.trim() !== initial.state.trim()) changes.profile.state = form.state.trim();
  if (editable.location && form.cityArea.trim() !== initial.cityArea.trim()) changes.profile.cityArea = form.cityArea.trim();
  if (editable.phone && normalisePhone(form.phone) !== normalisePhone(initial.phone)) changes.phone = normalisePhone(form.phone);
  return changes;
}

export function hasChanges(changes: PersonalDetailsChanges): boolean {
  return Object.keys(changes.profile).length > 0 || changes.phone !== undefined;
}

/** Problems with the fields that would be sent, by field. Empty when the save can go. */
export function personalDetailsProblems(
  initial: PersonalDetailsForm,
  form: PersonalDetailsForm,
  editable: ProfileEditable,
): Partial<Record<PersonalDetailsField, string>> {
  const changes = personalDetailsChanges(initial, form, editable);
  const problems: Partial<Record<PersonalDetailsField, string>> = {};
  const { name, state, cityArea } = changes.profile;
  if (name !== undefined) {
    if (name.length < 2) problems.name = 'Enter your full name';
    else if (name.length > 80) problems.name = 'Use 80 characters or fewer';
  }
  if (state !== undefined && !isNigerianState(state)) problems.state = 'Choose your state';
  if (cityArea !== undefined) {
    if (cityArea.length < 2) problems.cityArea = 'Enter your city, town or area';
    else if (cityArea.length > 80) problems.cityArea = 'Use 80 characters or fewer';
  }
  if (changes.phone !== undefined && !PHONE_E164.test(changes.phone)) {
    problems.phone = 'Enter your phone number with the country code, e.g. +234…';
  }
  return problems;
}
