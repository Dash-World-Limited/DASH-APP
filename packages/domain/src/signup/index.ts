/**
 * What a person tells DASH when they create an account.
 *
 * Pure vocabulary and validation. No database, no clock, no I/O.
 *
 * ## The rule this module exists to hold
 *
 * **Nothing here grants anything.** Usage intent and acquisition source are
 * profile and analytics fields. Somebody choosing "I sell regularly" on a
 * signup form has told us how they *plan* to use DASH; they have not become a
 * seller, and selling stays behind the existing KYC and admin approval that a
 * form cannot reach. The same goes for acquisition source: "a DASH World staff
 * member told me about it" is a marketing attribution, not a credential, and
 * treating it as one would make the signup form an authorisation bypass.
 *
 * These are self-reported answers on an open form. Anybody can type anything
 * into them, which is precisely why no decision may depend on them.
 */

// ---------------------------------------------------------------------------
// Where somebody is
// ---------------------------------------------------------------------------

/**
 * The thirty-six states and the Federal Capital Territory.
 *
 * Deliberately not `DECLUTTER_LOCATIONS`, which lists only Lagos and Delta.
 * That vocabulary describes where the marketplace can currently serve an item;
 * this one describes where a person lives, and refusing an account to somebody
 * in Kano because DASH does not yet deliver there would be turning away the
 * demand that decides where DASH expands next.
 *
 * Stored as the name rather than a code. There is no ISO code anybody in
 * Nigeria uses conversationally, and a two-letter abbreviation nobody
 * recognises is a column that has to be translated at every read.
 */
export const NIGERIAN_STATES = [
  'Abia',
  'Adamawa',
  'Akwa Ibom',
  'Anambra',
  'Bauchi',
  'Bayelsa',
  'Benue',
  'Borno',
  'Cross River',
  'Delta',
  'Ebonyi',
  'Edo',
  'Ekiti',
  'Enugu',
  'Federal Capital Territory',
  'Gombe',
  'Imo',
  'Jigawa',
  'Kaduna',
  'Kano',
  'Katsina',
  'Kebbi',
  'Kogi',
  'Kwara',
  'Lagos',
  'Nasarawa',
  'Niger',
  'Ogun',
  'Ondo',
  'Osun',
  'Oyo',
  'Plateau',
  'Rivers',
  'Sokoto',
  'Taraba',
  'Yobe',
  'Zamfara',
] as const;

export type NigerianState = (typeof NIGERIAN_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(NIGERIAN_STATES);

export function isNigerianState(value: string): value is NigerianState {
  return STATE_SET.has(value);
}

// ---------------------------------------------------------------------------
// How somebody plans to use DASH
// ---------------------------------------------------------------------------

/**
 * Self-reported intent. A plan, not a permission.
 *
 * Useful for two real questions — how much of the audience is supply and how
 * much is demand, and whether the people who said they would sell ever do.
 * Neither of those is an access-control decision.
 */
export const USAGE_INTENTS = [
  'mainly_buying',
  'occasional_seller',
  'regular_seller',
  'buying_and_selling',
] as const;

export type UsageIntent = (typeof USAGE_INTENTS)[number];

/** Natural wording. The question is "How do you plan to use DASH?" */
export const USAGE_INTENT_LABELS: Readonly<Record<UsageIntent, string>> = {
  mainly_buying: 'Mainly buying',
  occasional_seller: 'Selling the occasional item',
  regular_seller: 'Selling regularly',
  buying_and_selling: 'Both buying and selling',
};

export function isUsageIntent(value: string): value is UsageIntent {
  return (USAGE_INTENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// How somebody found DASH
// ---------------------------------------------------------------------------

export const ACQUISITION_SOURCES = [
  'referral',
  'dash_staff',
  'social_media',
  'search',
  'partner',
  'other',
] as const;

export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

export const ACQUISITION_SOURCE_LABELS: Readonly<Record<AcquisitionSource, string>> = {
  referral: 'Friend or referral',
  dash_staff: 'A DASH World staff member',
  social_media: 'DASH World social media',
  search: 'Google or search',
  partner: 'A partner',
  other: 'Somewhere else',
};

/**
 * Sources where a second question is worth asking, and what to ask.
 *
 * A referral without a name is an attribution nobody can act on, and "other"
 * without the detail is the same as no answer at all. The other sources are
 * self-describing and a follow-up field would be friction for nothing.
 */
export const ACQUISITION_DETAIL_PROMPTS: Readonly<Partial<Record<AcquisitionSource, string>>> = {
  referral: 'Who referred you?',
  dash_staff: 'Who did you speak to?',
  partner: 'Which partner?',
  other: 'Please specify',
};

export function isAcquisitionSource(value: string): value is AcquisitionSource {
  return (ACQUISITION_SOURCES as readonly string[]).includes(value);
}

export function acquisitionDetailPrompt(source: AcquisitionSource): string | null {
  return ACQUISITION_DETAIL_PROMPTS[source] ?? null;
}

/**
 * Whether the detail field must be filled in.
 *
 * A prompt is shown for a source, and the answer is then required — an empty
 * "who referred you?" is worse than not asking, because it looks like data.
 */
export function requiresAcquisitionDetail(source: AcquisitionSource): boolean {
  return acquisitionDetailPrompt(source) !== null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const SIGNUP_PROFILE_PROBLEMS = [
  'name_too_short',
  'state_unknown',
  'city_missing',
  'usage_intent_unknown',
  'acquisition_source_unknown',
  'acquisition_detail_missing',
  'age_not_confirmed',
  'terms_not_accepted',
] as const;

export type SignupProfileProblem = (typeof SIGNUP_PROFILE_PROBLEMS)[number];

export interface SignupProfile {
  readonly fullName: string;
  readonly state: string;
  readonly cityArea: string;
  readonly usageIntent: string;
  readonly acquisitionSource: string;
  readonly acquisitionDetail?: string | undefined;
  readonly confirmedAdult: boolean;
  readonly acceptedTerms: boolean;
  /**
   * Optional, always. Marketing consent is never a condition of holding a DASH
   * account, so it appears here and is deliberately absent from the problem
   * list below — there is no value of it that can fail validation.
   */
  readonly marketingOptIn: boolean;
}

/**
 * Everything wrong with a submitted profile, at once.
 *
 * All of it rather than the first problem, so a form can mark every field in
 * one pass instead of teaching somebody their mistakes one refusal at a time.
 */
export function signupProfileProblems(profile: SignupProfile): readonly SignupProfileProblem[] {
  const problems: SignupProfileProblem[] = [];

  if (profile.fullName.trim().length < 2) problems.push('name_too_short');
  if (!isNigerianState(profile.state.trim())) problems.push('state_unknown');
  if (profile.cityArea.trim().length < 2) problems.push('city_missing');
  if (!isUsageIntent(profile.usageIntent)) problems.push('usage_intent_unknown');

  if (!isAcquisitionSource(profile.acquisitionSource)) {
    problems.push('acquisition_source_unknown');
  } else if (
    requiresAcquisitionDetail(profile.acquisitionSource) &&
    (profile.acquisitionDetail ?? '').trim().length < 2
  ) {
    problems.push('acquisition_detail_missing');
  }

  // An attestation, not a date of birth. DASH has no reason to hold the actual
  // birthday of somebody who only wants to buy a sofa, and a date collected
  // "just in case" is a date that has to be protected, retained and eventually
  // deleted. If a seller's real DOB is ever needed it belongs in KYC evidence,
  // behind step-up, with the rest of their identity documents.
  if (!profile.confirmedAdult) problems.push('age_not_confirmed');
  if (!profile.acceptedTerms) problems.push('terms_not_accepted');

  return problems;
}

export function isCompleteSignupProfile(profile: SignupProfile): boolean {
  return signupProfileProblems(profile).length === 0;
}
