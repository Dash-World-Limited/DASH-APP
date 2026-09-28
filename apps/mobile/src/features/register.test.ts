/**
 * Registration: every mistake at once, the server's body exactly, and the
 * session adopted only from a real verification answer.
 */

import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import type { Session } from '../api/session';
import { EMPTY_REGISTRATION, registrationProblems, signupBody, verifyRegistration, type RegistrationForm } from './register';

const complete: RegistrationForm = {
  ...EMPTY_REGISTRATION,
  fullName: 'Ada Obi',
  email: '  Ada@Example.com ',
  phone: '+2348031234567',
  state: 'Lagos',
  cityArea: 'Lekki',
  usageIntent: 'mainly_buying',
  acquisitionSource: 'social_media',
  confirmedAdult: true,
  acceptedTerms: true,
};

describe('the registration form', () => {
  it('has no problems when complete', () => {
    expect(registrationProblems(complete)).toEqual({});
  });

  it('marks every mistake at once, by field', () => {
    const problems = registrationProblems(EMPTY_REGISTRATION);
    for (const field of ['fullName', 'email', 'phone', 'state', 'cityArea', 'acquisitionSource', 'confirmedAdult', 'acceptedTerms']) {
      expect(problems, field).toHaveProperty(field);
    }
  });

  it('requires the phone in international format, and never claims to verify it', () => {
    expect(registrationProblems({ ...complete, phone: '08031234567' })).toHaveProperty('phone');
    expect(JSON.stringify(signupBody(complete))).not.toMatch(/verif/i);
  });

  it('sends the server exactly its fields, with the email normalised', () => {
    expect(signupBody(complete)).toEqual({
      name: 'Ada Obi',
      email: 'ada@example.com',
      phone: '+2348031234567',
      state: 'Lagos',
      cityArea: 'Lekki',
      usageIntent: 'mainly_buying',
      acquisitionSource: 'social_media',
      confirmedAdult: true,
      acceptedTerms: true,
      marketingOptIn: false,
    });
  });
});

describe('verification', () => {
  function fake(answer: unknown) {
    const calls: { path: string; options: RequestOptions }[] = [];
    const adopted: unknown[] = [];
    const api = {
      configured: true,
      request: async (path: string, options: RequestOptions = {}) => {
        calls.push({ path, options });
        return answer;
      },
      restore: async () => 'authenticated',
      signOut: async () => undefined,
    } as unknown as ApiClient;
    const session = { adopt: async (tokens: unknown) => void adopted.push(tokens) } as unknown as Session;
    return { api, session, calls, adopted };
  }

  it('adopts the session the verification returns', async () => {
    const { api, session, calls, adopted } = fake({ accessToken: 'at', csrfToken: 'cs', verified: true });
    await verifyRegistration(api, session, 'Ada@Example.com', '12 34 56');
    expect(calls[0]).toMatchObject({ path: '/v1/auth/email/verify', options: { method: 'POST', body: { email: 'ada@example.com', code: '123456' } } });
    expect(adopted).toEqual([{ accessToken: 'at', csrfToken: 'cs' }]);
  });

  it('adopts nothing from an answer without a token', async () => {
    const { api, session, adopted } = fake({ verified: true });
    await expect(verifyRegistration(api, session, 'ada@example.com', '123456')).rejects.toThrow();
    expect(adopted).toEqual([]);
  });
});
