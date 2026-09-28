/**
 * Creating a DASH account from the app.
 *
 * Signup collects name, email, phone and a short profile; the email is then
 * proved with a six-digit code, and proving it signs the person in (the
 * server issues the session at that moment). The phone number is stored and
 * never verified — SMS is off in V1 — and nothing here says otherwise.
 *
 * The server answers signup identically whether or not the address already
 * has an account, so this module never tells anyone that it does.
 *
 * Validation mirrors the server's (`@dash/domain/signup`) so every mistake is
 * shown at once, before a request; the server re-checks everything.
 */

import { signupProfileProblems, type SignupProfileProblem } from '@dash/domain/signup';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { Session } from '../api/session';
import { codeDigits, emailProblem, normaliseEmail } from './signIn';

export interface RegistrationForm {
  fullName: string;
  email: string;
  phone: string;
  state: string;
  cityArea: string;
  usageIntent: string;
  acquisitionSource: string;
  acquisitionDetail: string;
  confirmedAdult: boolean;
  acceptedTerms: boolean;
  marketingOptIn: boolean;
}

export const EMPTY_REGISTRATION: RegistrationForm = {
  fullName: '',
  email: '',
  phone: '+234',
  state: '',
  cityArea: '',
  usageIntent: 'mainly_buying',
  acquisitionSource: '',
  acquisitionDetail: '',
  confirmedAdult: false,
  acceptedTerms: false,
  marketingOptIn: false,
};

export type RegistrationField = keyof RegistrationForm;

const PROBLEM_FIELD: Record<SignupProfileProblem, { field: RegistrationField; message: string }> = {
  name_too_short: { field: 'fullName', message: 'Enter your full name' },
  state_unknown: { field: 'state', message: 'Choose your state' },
  city_missing: { field: 'cityArea', message: 'Enter your city, town or area' },
  usage_intent_unknown: { field: 'usageIntent', message: 'Choose how you plan to use DASH' },
  acquisition_source_unknown: { field: 'acquisitionSource', message: 'Tell us how you heard about DASH' },
  acquisition_detail_missing: { field: 'acquisitionDetail', message: 'Tell us a little more' },
  age_not_confirmed: { field: 'confirmedAdult', message: 'You must be 18 or older to create an account' },
  terms_not_accepted: { field: 'acceptedTerms', message: 'Accept the terms to create an account' },
};

/** E.164, as the server requires. */
export const PHONE_E164 = /^\+[1-9]\d{7,14}$/;

/** Every problem with the form, by field. Empty when it can be sent. */
export function registrationProblems(form: RegistrationForm): Partial<Record<RegistrationField, string>> {
  const problems: Partial<Record<RegistrationField, string>> = {};
  const email = emailProblem(form.email);
  if (email) problems.email = email;
  if (!PHONE_E164.test(form.phone.trim())) problems.phone = 'Enter your phone number with the country code, e.g. +234…';
  for (const problem of signupProfileProblems({
    fullName: form.fullName,
    state: form.state,
    cityArea: form.cityArea,
    usageIntent: form.usageIntent,
    acquisitionSource: form.acquisitionSource,
    acquisitionDetail: form.acquisitionDetail,
    confirmedAdult: form.confirmedAdult,
    acceptedTerms: form.acceptedTerms,
    marketingOptIn: form.marketingOptIn,
  })) {
    const { field, message } = PROBLEM_FIELD[problem];
    problems[field] ??= message;
  }
  return problems;
}

/** The body POST /v1/auth/signup expects. */
export function signupBody(form: RegistrationForm): Record<string, unknown> {
  const detail = form.acquisitionDetail.trim();
  return {
    name: form.fullName.trim(),
    email: normaliseEmail(form.email),
    phone: form.phone.trim(),
    state: form.state,
    cityArea: form.cityArea.trim(),
    usageIntent: form.usageIntent,
    acquisitionSource: form.acquisitionSource,
    ...(detail ? { acquisitionDetail: detail } : {}),
    confirmedAdult: true,
    acceptedTerms: true,
    marketingOptIn: form.marketingOptIn,
  };
}

export async function submitRegistration(api: ApiClient, form: RegistrationForm): Promise<{ expiresInSeconds: number }> {
  const response = await api.request<{ expiresInSeconds?: unknown }>('/v1/auth/signup', { method: 'POST', auth: false, body: signupBody(form) });
  return { expiresInSeconds: typeof response.expiresInSeconds === 'number' ? response.expiresInSeconds : 300 };
}

export async function resendVerification(api: ApiClient, email: string): Promise<void> {
  await api.request('/v1/auth/email/resend', { method: 'POST', auth: false, body: { email: normaliseEmail(email) } });
}

/** Redeem the code. Proving the address signs the person in; adopt that session. */
export async function verifyRegistration(api: ApiClient, session: Session, email: string, code: string): Promise<void> {
  const tokens = await api.request<{ accessToken?: unknown; csrfToken?: unknown }>('/v1/auth/email/verify', {
    method: 'POST',
    auth: false,
    body: { email: normaliseEmail(email), code: codeDigits(code) },
  });
  if (typeof tokens.accessToken !== 'string') {
    throw new ApiError(502, 'bad_sign_in', 'Your email is verified, but signing you in did not finish. Sign in with a code.');
  }
  await session.adopt({ accessToken: tokens.accessToken, csrfToken: typeof tokens.csrfToken === 'string' ? tokens.csrfToken : null });
}
