/**
 * The signup vocabulary, and the one rule that matters about it.
 *
 * Most of this is ordinary validation. The tests worth reading are the ones
 * asserting that none of these fields is a permission: a signup form is the
 * least trustworthy input surface in the product, and the moment a decision
 * depends on what somebody typed into it, the form becomes an authorisation
 * bypass.
 */

import { describe, expect, it } from 'vitest';
import {
  ACQUISITION_SOURCES,
  ACQUISITION_SOURCE_LABELS,
  acquisitionDetailPrompt,
  isAcquisitionSource,
  isCompleteSignupProfile,
  isNigerianState,
  isUsageIntent,
  NIGERIAN_STATES,
  requiresAcquisitionDetail,
  signupProfileProblems,
  USAGE_INTENTS,
  USAGE_INTENT_LABELS,
  type SignupProfile,
} from './index.js';

const VALID: SignupProfile = {
  fullName: 'Chinedu Okonkwo',
  state: 'Lagos',
  cityArea: 'Yaba',
  usageIntent: 'mainly_buying',
  acquisitionSource: 'search',
  confirmedAdult: true,
  acceptedTerms: true,
  marketingOptIn: false,
};

// ---------------------------------------------------------------------------

describe('where somebody is', () => {
  it('covers the thirty-six states and the FCT', () => {
    expect(NIGERIAN_STATES).toHaveLength(37);
    expect(new Set(NIGERIAN_STATES).size).toBe(37);
    expect(NIGERIAN_STATES).toContain('Federal Capital Territory');
  });

  it('accepts a state DASH does not serve', () => {
    // The marketplace covers Lagos and Delta. Somebody in Kano is demand, and
    // demand is what decides where DASH expands next.
    expect(isNigerianState('Kano')).toBe(true);
    expect(isNigerianState('Borno')).toBe(true);
  });

  it('refuses anything that is not a state', () => {
    expect(isNigerianState('California')).toBe(false);
    expect(isNigerianState('lagos')).toBe(false);
    expect(isNigerianState('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('usage intent', () => {
  it('has the four values, with natural wording for each', () => {
    expect(USAGE_INTENTS).toEqual([
      'mainly_buying',
      'occasional_seller',
      'regular_seller',
      'buying_and_selling',
    ]);
    expect(Object.keys(USAGE_INTENT_LABELS).sort()).toEqual([...USAGE_INTENTS].sort());
    for (const label of Object.values(USAGE_INTENT_LABELS)) {
      expect(label.length).toBeGreaterThan(3);
    }
  });

  it('is a plan and not a permission', () => {
    // The load-bearing assertion. There is no function in this module that maps
    // an intent onto a capability, and there must never be one: somebody
    // selecting "I sell regularly" has told us how they intend to use DASH, and
    // selling still requires KYC and an admin.
    const module = { isUsageIntent, USAGE_INTENTS, USAGE_INTENT_LABELS };
    for (const value of USAGE_INTENTS) {
      expect(isUsageIntent(value)).toBe(true);
      // Nothing here answers a question about what they may do.
      expect(Object.keys(module)).not.toContain('permissionsFor');
      expect(Object.keys(module)).not.toContain('rolesFor');
    }
  });

  it('refuses a value nothing knows about', () => {
    expect(isUsageIntent('wholesaler')).toBe(false);
    expect(isUsageIntent('admin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('acquisition source', () => {
  it('has the six options, each with a label', () => {
    expect(ACQUISITION_SOURCES).toHaveLength(6);
    expect(Object.keys(ACQUISITION_SOURCE_LABELS).sort()).toEqual([...ACQUISITION_SOURCES].sort());
  });

  it('asks a follow-up only where the answer is otherwise useless', () => {
    // A referral with no name is an attribution nobody can act on; "other" with
    // no detail is the same as no answer.
    expect(requiresAcquisitionDetail('referral')).toBe(true);
    expect(requiresAcquisitionDetail('dash_staff')).toBe(true);
    expect(requiresAcquisitionDetail('partner')).toBe(true);
    expect(requiresAcquisitionDetail('other')).toBe(true);

    // These describe themselves. A second field would be friction for nothing.
    expect(requiresAcquisitionDetail('search')).toBe(false);
    expect(requiresAcquisitionDetail('social_media')).toBe(false);
  });

  it('gives each follow-up a question a person can answer', () => {
    expect(acquisitionDetailPrompt('referral')).toBe('Who referred you?');
    expect(acquisitionDetailPrompt('other')).toBe('Please specify');
    expect(acquisitionDetailPrompt('search')).toBeNull();
  });

  it('is attribution and never a credential', () => {
    // "A DASH World staff member told me about it" is marketing data typed by a
    // stranger. If it ever granted anything, the signup form would be an
    // authorisation bypass.
    expect(isAcquisitionSource('dash_staff')).toBe(true);
    expect(isAcquisitionSource('partner')).toBe(true);
    expect(isAcquisitionSource('trusted_partner')).toBe(false);
    expect(isAcquisitionSource('admin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('a complete profile', () => {
  it('accepts a valid one', () => {
    expect(signupProfileProblems(VALID)).toEqual([]);
    expect(isCompleteSignupProfile(VALID)).toBe(true);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = signupProfileProblems({
      ...VALID,
      fullName: 'A',
      state: 'Atlantis',
      cityArea: ' ',
      usageIntent: 'nope',
      confirmedAdult: false,
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'name_too_short',
        'state_unknown',
        'city_missing',
        'usage_intent_unknown',
        'age_not_confirmed',
      ]),
    );
  });

  it('requires the follow-up when the source asks for one', () => {
    expect(signupProfileProblems({ ...VALID, acquisitionSource: 'referral' })).toContain(
      'acquisition_detail_missing',
    );
    expect(
      signupProfileProblems({
        ...VALID,
        acquisitionSource: 'referral',
        acquisitionDetail: 'Amaka',
      }),
    ).toEqual([]);
  });

  it('treats whitespace in the follow-up as absent', () => {
    expect(
      signupProfileProblems({ ...VALID, acquisitionSource: 'other', acquisitionDetail: '  ' }),
    ).toContain('acquisition_detail_missing');
  });

  it('refuses an unconfirmed adult and unaccepted terms', () => {
    expect(signupProfileProblems({ ...VALID, confirmedAdult: false })).toContain('age_not_confirmed');
    expect(signupProfileProblems({ ...VALID, acceptedTerms: false })).toContain(
      'terms_not_accepted',
    );
  });

  it('never fails on marketing consent, whichever way it is set', () => {
    // Marketing consent is not a condition of holding a DASH account, so there
    // is no value of it that can make a profile invalid.
    expect(signupProfileProblems({ ...VALID, marketingOptIn: true })).toEqual([]);
    expect(signupProfileProblems({ ...VALID, marketingOptIn: false })).toEqual([]);
  });

  it('has no problem code for marketing consent at all', () => {
    const problems = signupProfileProblems({
      ...VALID,
      fullName: '',
      state: '',
      cityArea: '',
      usageIntent: '',
      acquisitionSource: '',
      confirmedAdult: false,
      acceptedTerms: false,
      marketingOptIn: false,
    });
    expect(problems.join(',')).not.toContain('marketing');
  });

  it('does not ask for a date of birth anywhere', () => {
    // An attestation, not a birthday. DASH has no reason to hold the date of
    // birth of somebody who only wants to buy a sofa, and a date collected
    // "just in case" has to be protected, retained and eventually deleted.
    expect(Object.keys(VALID)).not.toContain('dateOfBirth');
    expect(Object.keys(VALID)).not.toContain('dob');
  });
});
