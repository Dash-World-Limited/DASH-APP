import { describe, expect, it } from 'vitest';
import {
  assessSellerIdentity,
  availabilityMachine,
  AVAILABILITY_STATES,
  compareNames,
  contactRequestMachine,
  CONTACT_REQUEST_STATES,
  DeclutterTransitionError,
  isPubliclyActionable,
  isPubliclyVisible,
  materialFieldsIn,
  MODERATION_STATES,
  moderationMachine,
  normaliseName,
  reasonRequired,
  requiresRemoderation,
  SUBMISSION_STATES,
  SUBMISSION_TERMINAL,
  submissionMachine,
  canVerifySeller,
  isIdentityDocumentKind,
  verificationGaps,
  VERIFICATION_GAP_LABELS,
  accessIsRevocable,
  CONTACT_METHODS,
  DEFAULT_CONTACT_METHOD,
  disclosedFieldsFor,
  isMediatedContact,
  requiresApprovalReason,
  requiresSellerConsent,
  type DeclutterActor,
} from './index.js';
import {
  PERMISSIONS,
  permissionsForRoles,
  STAFF_ROLES,
  STEP_UP_PERMISSIONS,
} from '../permissions/index.js';

const ALL_ACTORS: readonly DeclutterActor[] = [
  'seller',
  'buyer',
  'staff',
  'admin',
  'super_admin',
  'system',
];

// ---------------------------------------------------------------------------
// State machine integrity
// ---------------------------------------------------------------------------

describe('state machine integrity', () => {
  it('defines transitions for every declared state', () => {
    for (const state of SUBMISSION_STATES) {
      expect(() => submissionMachine.allowedFor(state, 'admin')).not.toThrow();
    }
    for (const state of MODERATION_STATES) {
      expect(() => moderationMachine.allowedFor(state, 'admin')).not.toThrow();
    }
    for (const state of AVAILABILITY_STATES) {
      expect(() => availabilityMachine.allowedFor(state, 'admin')).not.toThrow();
    }
    for (const state of CONTACT_REQUEST_STATES) {
      expect(() => contactRequestMachine.allowedFor(state, 'admin')).not.toThrow();
    }
  });

  it('lets nothing leave a terminal submission state', () => {
    for (const state of SUBMISSION_TERMINAL) {
      for (const actor of ALL_ACTORS) {
        expect(submissionMachine.allowedFor(state, actor)).toEqual([]);
      }
    }
  });

  it('refuses an unknown transition with a typed error', () => {
    expect(() => submissionMachine.assert('intake', 'published', 'super_admin')).toThrow(
      DeclutterTransitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// The rules the product depends on
// ---------------------------------------------------------------------------

describe('a seller cannot publish themselves', () => {
  it('gives no actor a direct route from intake to published', () => {
    for (const actor of ALL_ACTORS) {
      expect(submissionMachine.allowedFor('intake', actor)).not.toContain('published');
    }
  });

  it('only admins may publish an approved submission', () => {
    expect(submissionMachine.can('approved', 'published', 'seller')).toBe(false);
    expect(submissionMachine.can('approved', 'published', 'staff')).toBe(false);
    expect(submissionMachine.can('approved', 'published', 'system')).toBe(false);
    expect(submissionMachine.can('approved', 'published', 'admin')).toBe(true);
  });

  it('only admins may approve a listing for the public', () => {
    expect(moderationMachine.can('pending_review', 'approved', 'seller')).toBe(false);
    expect(moderationMachine.can('pending_review', 'approved', 'staff')).toBe(false);
    expect(moderationMachine.can('pending_review', 'approved', 'system')).toBe(false);
    expect(moderationMachine.can('pending_review', 'approved', 'admin')).toBe(true);
  });
});

describe('the seller must accept the final price', () => {
  it('routes every path to approved through seller acceptance', () => {
    // `approved` means "the seller said yes". Reaching it from anywhere other
    // than `seller_acceptance_pending` would mean publishing a price nobody
    // agreed to.
    for (const state of SUBMISSION_STATES) {
      if (state === 'seller_acceptance_pending') continue;
      for (const actor of ALL_ACTORS) {
        expect(submissionMachine.allowedFor(state, actor)).not.toContain('approved');
      }
    }
  });
});

describe('automation may not price or publish', () => {
  it('never lets system reach a pricing or publication state', () => {
    for (const state of SUBMISSION_STATES) {
      const reachable = submissionMachine.allowedFor(state, 'system');
      expect(reachable).not.toContain('seller_acceptance_pending');
      expect(reachable).not.toContain('approved');
      expect(reachable).not.toContain('published');
    }
  });

  it('never lets system approve or suspend a listing', () => {
    for (const state of MODERATION_STATES) {
      const reachable = moderationMachine.allowedFor(state, 'system');
      expect(reachable).not.toContain('approved');
      expect(reachable).not.toContain('suspended');
    }
  });

  it('never lets system mark an item sold', () => {
    for (const state of AVAILABILITY_STATES) {
      expect(availabilityMachine.allowedFor(state, 'system')).not.toContain('sold');
    }
  });
});

describe('a sold item cannot come back', () => {
  it('offers no path from sold to available', () => {
    for (const actor of ALL_ACTORS) {
      expect(availabilityMachine.allowedFor('sold', actor)).not.toContain('available');
    }
  });
});

describe('public visibility needs both axes to agree', () => {
  it('hides anything not approved', () => {
    expect(isPubliclyVisible('pending_review', 'available')).toBe(false);
    expect(isPubliclyVisible('suspended', 'available')).toBe(false);
    expect(isPubliclyVisible('rejected', 'available')).toBe(false);
  });

  it('shows reserved items but does not let anyone act on them', () => {
    expect(isPubliclyVisible('approved', 'reserved')).toBe(true);
    expect(isPubliclyActionable('approved', 'reserved')).toBe(false);
  });

  it('hides sold and unavailable items', () => {
    expect(isPubliclyVisible('approved', 'sold')).toBe(false);
    expect(isPubliclyVisible('approved', 'unavailable')).toBe(false);
  });
});

describe('material edits re-enter moderation', () => {
  it('catches every field that defines the item or its price', () => {
    expect(requiresRemoderation(['priceKobo'])).toBe(true);
    expect(requiresRemoderation(['photos'])).toBe(true);
    expect(requiresRemoderation(['title', 'viewCount'])).toBe(true);
    expect(materialFieldsIn(['title', 'viewCount'])).toEqual(['title']);
  });

  it('ignores changes that do not alter what is being sold', () => {
    expect(requiresRemoderation(['viewCount'])).toBe(false);
    expect(requiresRemoderation([])).toBe(false);
  });
});

describe('destructive transitions demand a reason', () => {
  it('requires one wherever a person is told no or a listing disappears', () => {
    expect(reasonRequired('submission', 'rejected')).toBe(true);
    expect(reasonRequired('listing.moderation', 'suspended')).toBe(true);
    expect(reasonRequired('listing.availability', 'sold')).toBe(true);
    expect(reasonRequired('contact_request', 'revoked')).toBe(true);
    expect(reasonRequired('submission', 'valuation_pending')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identity matching
// ---------------------------------------------------------------------------

describe('seller name matching', () => {
  it('normalises punctuation, accents, case and honorifics', () => {
    expect(normaliseName("  Mr. Chinedu  O'Brien-Okonkwo ")).toEqual([
      'CHINEDU',
      'O',
      'BRIEN',
      'OKONKWO',
    ]);
  });

  it('matches a surname-first record against a surname-last one', () => {
    const result = compareNames('OKONKWO CHINEDU EMEKA', 'Chinedu Emeka Okonkwo');
    expect(result.verdict).toBe('match');
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it('accepts a middle initial standing in for a middle name', () => {
    const result = compareNames('Chinedu Emeka Okonkwo', 'Chinedu E. Okonkwo');
    expect(result.verdict).toBe('match');
  });

  it('accepts a dropped middle name', () => {
    expect(compareNames('Chinedu Emeka Okonkwo', 'Chinedu Okonkwo').verdict).toBe('match');
  });

  it('refuses a different surname', () => {
    const result = compareNames('Chinedu Okonkwo', 'Chinedu Adeyemi');
    expect(result.verdict).not.toBe('match');
  });

  it('never auto-accepts a single-word name', () => {
    // "CHINEDU" alone identifies thousands of people, so it must reach a human
    // however well it matches.
    expect(compareNames('Chinedu', 'Chinedu').verdict).not.toBe('match');
  });

  it('rejects empty input rather than scoring it', () => {
    expect(compareNames('   ', 'Chinedu Okonkwo').verdict).toBe('mismatch');
    expect(compareNames('...', 'Chinedu Okonkwo').score).toBe(0);
  });

  it('takes the worst of the three pairings, never the average', () => {
    // Strong declared/identity agreement must not paper over a bank account in
    // an unrelated name — the exact shape of a payout fraud.
    const assessment = assessSellerIdentity({
      declaredName: 'Chinedu Emeka Okonkwo',
      identityName: 'OKONKWO CHINEDU EMEKA',
      bankAccountName: 'Musa Ibrahim Bello',
    });
    expect(assessment.verdict).not.toBe('match');
    expect(assessment.weakestPair).not.toBe('declared_vs_identity');
  });

  it('compares only the names it was given when there is no bank account', () => {
    // A bank account exists to be paid into, and nobody has been paid yet.
    // Verification must not stall on evidence the product has not asked for.
    const assessment = assessSellerIdentity({
      declaredName: 'Chinedu Emeka Okonkwo',
      identityName: 'OKONKWO CHINEDU EMEKA',
    });
    expect(assessment.bankChecked).toBe(false);
    expect(assessment.verdict).toBe('match');
    expect(assessment.weakestPair).toBe('declared_vs_identity');
    expect(assessment.pairs.declaredVsBank).toBeNull();
  });

  it('still refuses a bank account in an unrelated name when one is given', () => {
    const assessment = assessSellerIdentity({
      declaredName: 'Chinedu Emeka Okonkwo',
      identityName: 'OKONKWO CHINEDU EMEKA',
      bankAccountName: 'Musa Ibrahim Bello',
    });
    expect(assessment.bankChecked).toBe(true);
    expect(assessment.verdict).not.toBe('match');
  });

  it('passes a consistent three-way identity', () => {
    const assessment = assessSellerIdentity({
      declaredName: 'Chinedu Emeka Okonkwo',
      identityName: 'OKONKWO CHINEDU EMEKA',
      bankAccountName: 'Chinedu E Okonkwo',
    });
    expect(assessment.verdict).toBe('match');
  });
});

// ---------------------------------------------------------------------------
// Contact: what a grant can and cannot take back
// ---------------------------------------------------------------------------

describe('contact access is honest about revocation', () => {
  it('treats mediated access as genuinely revocable', () => {
    expect(accessIsRevocable('dash_relay')).toBe(true);
    expect(accessIsRevocable('masked_relay')).toBe(true);
  });

  it('refuses to claim a disclosed number can be un-disclosed', () => {
    // Revoking a direct grant closes the app's door and nothing else. The
    // buyer's phone still has the number.
    expect(accessIsRevocable('whatsapp_direct')).toBe(false);
    expect(accessIsRevocable('phone_direct')).toBe(false);
  });

  it('defaults V1 to DASH mediating, so nothing leaves the platform', () => {
    expect(DEFAULT_CONTACT_METHOD).toBe('dash_relay');
    expect(isMediatedContact(DEFAULT_CONTACT_METHOD)).toBe(true);
    expect(disclosedFieldsFor(DEFAULT_CONTACT_METHOD)).toEqual([]);
  });

  it('demands seller consent and a reason only where something real is handed over', () => {
    for (const method of CONTACT_METHODS) {
      const direct = !isMediatedContact(method);
      expect(requiresSellerConsent(method)).toBe(direct);
      expect(requiresApprovalReason(method)).toBe(direct);
    }
  });

  it('names exactly what each method reveals', () => {
    expect(disclosedFieldsFor('whatsapp_direct')).toEqual(['seller_whatsapp']);
    expect(disclosedFieldsFor('phone_direct')).toEqual(['seller_phone']);
    expect(disclosedFieldsFor('masked_relay')).toEqual(['proxy_channel']);
  });
});

// ---------------------------------------------------------------------------
// Roles: preparing work and deciding it are different jobs
// ---------------------------------------------------------------------------

describe('declutter roles', () => {
  const moderator = permissionsForRoles(['declutter_moderator']);
  const admin = permissionsForRoles(['declutter_admin']);

  it('lets a moderator prepare work', () => {
    expect(moderator.has('declutter:submission:write')).toBe(true);
    expect(moderator.has('declutter:valuation:run')).toBe(true);
    expect(moderator.has('declutter:listing:write')).toBe(true);
  });

  it('stops a moderator doing anything a member of the public would feel', () => {
    expect(moderator.has('declutter:listing:publish')).toBe(false);
    expect(moderator.has('declutter:price:decide')).toBe(false);
    expect(moderator.has('declutter:kyc:review')).toBe(false);
    expect(moderator.has('declutter:contact:disclose:direct')).toBe(false);
    expect(moderator.has('declutter:fraud:override')).toBe(false);
  });

  it('gives an admin everything a moderator has, and the decisions too', () => {
    for (const permission of moderator) {
      expect(admin.has(permission)).toBe(true);
    }
    expect(admin.has('declutter:listing:publish')).toBe(true);
    expect(admin.has('declutter:price:decide')).toBe(true);
  });

  it('keeps the marketplace out of platform_admin by default', () => {
    // Least privilege: running a second-hand marketplace is not implied by
    // administering DASH. An identity may hold both roles when that is the job.
    const platform = permissionsForRoles(['platform_admin']);
    expect(platform.has('declutter:listing:publish')).toBe(false);
    expect(platform.has('declutter:contact:disclose:direct')).toBe(false);
  });

  it('still gives super_admin every declutter permission', () => {
    const superAdmin = permissionsForRoles(['super_admin']);
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('declutter:'))) {
      expect(superAdmin.has(permission)).toBe(true);
    }
  });

  it('step-up gates the three irreversible or personal actions', () => {
    expect(STEP_UP_PERMISSIONS.has('declutter:kyc:review')).toBe(true);
    expect(STEP_UP_PERMISSIONS.has('declutter:contact:disclose:direct')).toBe(true);
    expect(STEP_UP_PERMISSIONS.has('declutter:fraud:override')).toBe(true);
    // Ordinary preparation is not gated — moderation would stop being done.
    expect(STEP_UP_PERMISSIONS.has('declutter:submission:write')).toBe(false);
  });

  it('requires both declutter roles to sign in as staff, with MFA', () => {
    expect(STAFF_ROLES.has('declutter_moderator')).toBe(true);
    expect(STAFF_ROLES.has('declutter_admin')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What verification requires
// ---------------------------------------------------------------------------

describe('verification needs evidence, not a filled form', () => {
  const complete = {
    legalName: 'Chinedu Okonkwo',
    nationalIdOnFile: true,
    phoneOnFile: true,
    acceptedIdentityDocuments: 1,
  };

  it('clears a seller with a name, an identifier, a phone and an accepted document', () => {
    expect(verificationGaps(complete)).toEqual([]);
    expect(canVerifySeller(complete)).toBe(true);
  });

  it('refuses a seller who typed everything but produced no document', () => {
    const gaps = verificationGaps({ ...complete, acceptedIdentityDocuments: 0 });
    expect(gaps).toEqual(['accepted_identity_document']);
    expect(canVerifySeller({ ...complete, acceptedIdentityDocuments: 0 })).toBe(false);
  });

  it('names every gap so a screen can say what is outstanding', () => {
    const gaps = verificationGaps({
      legalName: '   ',
      nationalIdOnFile: false,
      phoneOnFile: false,
      acceptedIdentityDocuments: 0,
    });
    expect(gaps).toEqual(['legal_name', 'national_id', 'phone', 'accepted_identity_document']);
    for (const gap of gaps) {
      expect(VERIFICATION_GAP_LABELS[gap]).toBeTruthy();
    }
  });

  it('accepts only government photo identity as an identity document', () => {
    expect(isIdentityDocumentKind('passport')).toBe(true);
    expect(isIdentityDocumentKind('national_id')).toBe(true);
    // A utility bill proves an address, not a person.
    expect(isIdentityDocumentKind('proof_of_address')).toBe(false);
    expect(isIdentityDocumentKind('selfie')).toBe(false);
  });
});
