import { describe, expect, it } from 'vitest';
import type { DeliveryReceipt, EmailPort } from '@dash/domain/ports';
import { otpEmailContent } from '../auth/otp-delivery.js';
import { dashEmailHtml } from '../email/dash-brand.js';
import {
  DECLUTTER_ADMIN_EMAILS,
  notifyDeclutterSubmissionCreated,
  notifySellerVerificationSubmitted,
  notifySellerDecision,
  notifyListingPublished,
} from '../declutter/notifications.js';

class CaptureEmail implements EmailPort {
  readonly providerName = 'capture';
  readonly isLive = false;
  readonly sent: Array<{
    to: string;
    subject: string;
    html: string;
    text: string;
    reference: string;
  }> = [];

  async send(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    reference: string;
  }): Promise<DeliveryReceipt> {
    this.sent.push(input);
    return { accepted: true, providerMessageId: `capture-${this.sent.length}` };
  }
}

describe('DASH transactional email', () => {
  it('uses the one DASH code identity for email verification', () => {
    const email = otpEmailContent({
      code: '934861',
      ttlSeconds: 300,
      purpose: 'email_verify',
      displayName: 'David',
    });

    expect(email.subject).toBe('934861 is your DASH code');
    expect(email.html).toContain('Your DASH code');
    expect(email.html).toContain('934861');
    expect(email.text).toContain('Beyond the Digital');
    expect(email.subject).not.toContain('DASH World Limited');
  });

  it('escapes user-authored values before rendering HTML', () => {
    const html = dashEmailHtml({
      previewText: '<script>alert(1)</script>',
      title: 'Item <img src=x onerror=alert(1)>',
      greeting: 'Hello <b>seller</b>',
      details: [{ label: 'Item', value: '<svg onload=alert(1)>' }],
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<svg onload=alert(1)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
  });
});

describe('Declutters notification routing', () => {
  it('escapes seller names, item titles and rejection reasons in every workflow', async () => {
    const email = new CaptureEmail();
    const malicious = '<img src=x onerror="steal()">';
    const common = { sellerEmail: 'seller@example.com', sellerName: malicious, sellerId: 'seller-escape', publicWebUrl: 'https://dashworldng.com' };
    await notifySellerVerificationSubmitted(email, common);
    await notifyDeclutterSubmissionCreated(email, { ...common, kycStatus: 'verified', submissionId: 'escape', submissionCode: 'DCL-ESCAPE', itemTitle: malicious });
    for (const decision of ['verified', 'rejected', 'suspended'] as const) await notifySellerDecision(email, { ...common, decision, reason: malicious });
    await notifyListingPublished(email, { ...common, listingId: 'escape', slug: 'escaped-item', itemTitle: malicious });
    for (const message of email.sent) {
      expect(message.html).not.toContain(malicious);
      expect(message.html).toContain('&lt;img src=x onerror=&quot;steal()&quot;&gt;');
    }
    expect(email.sent.at(-1)?.html).toContain('https://dashworldng.com/declutter/escaped-item');
  });

  it('escapes all layout text and link attributes', () => {
    const value = `<>&"'`;
    const html = dashEmailHtml({ previewText: value, eyebrow: value, title: value, greeting: value, paragraphs: [value], code: value, details: [{ label: value, value }], cta: { label: value, href: `https://dashworldng.com/?q=${value}` }, securityNote: value });
    expect(html).not.toContain(value);
    expect(html).toContain('&lt;&gt;&amp;&quot;&#39;');
    expect(html).toContain('href="https://dashworldng.com/?q=&lt;&gt;&amp;&quot;&#39;"');
  });

  it('attempts both admin inboxes when seller delivery throws', async () => {
    const email = new CaptureEmail();
    const original = email.send.bind(email);
    email.send = async (message) => {
      if (message.to === 'seller@example.com') throw new Error('fixture');
      return original(message);
    };
    expect(await notifySellerVerificationSubmitted(email, { sellerEmail: 'seller@example.com', sellerName: 'Ada', sellerId: 's1', publicWebUrl: 'https://dashworldng.com' })).toEqual({ attempted: 3, failed: 1 });
    expect(email.sent.map(m => m.to)).toEqual([...DECLUTTER_ADMIN_EMAILS]);
  });

  it('alerts the seller and both independent admin inboxes after an item is completed', async () => {
    const email = new CaptureEmail();

    const result = await notifyDeclutterSubmissionCreated(email, {
      sellerEmail: 'seller@example.com',
      sellerName: 'Ada Seller',
      sellerId: 'seller-1',
      kycStatus: 'unverified',
      submissionId: 'submission-1',
      submissionCode: 'DCL-ABC123',
      itemTitle: 'Samsung Galaxy S23',
      publicWebUrl: 'https://dashworldng.com',
    });

    expect(result).toEqual({ attempted: 3, failed: 0 });
    expect(email.sent.map((message) => message.to).sort()).toEqual(
      ['seller@example.com', ...DECLUTTER_ADMIN_EMAILS].sort(),
    );

    const seller = email.sent.find((message) => message.to === 'seller@example.com');
    expect(seller?.subject).toBe('We received your Samsung Galaxy S23 listing');
    expect(seller?.html).toContain('Verify your seller profile');
    expect(seller?.html).toContain('DCL-ABC123');
  });

  it('never attaches identity evidence to the admin verification email', async () => {
    const email = new CaptureEmail();

    await notifySellerVerificationSubmitted(email, {
      sellerEmail: 'seller@example.com',
      sellerName: 'Ada Seller',
      sellerId: 'seller-1',
      publicWebUrl: 'https://dashworldng.com',
    });

    const adminMessages = email.sent.filter((message) =>
      (DECLUTTER_ADMIN_EMAILS as readonly string[]).includes(message.to),
    );

    expect(adminMessages).toHaveLength(2);
    for (const message of adminMessages) {
      expect(message.html).toContain('/ops/declutter');
      expect(message.html).toContain('never attached to email');
      expect(message.html).not.toContain('nationalId');
      expect(message.html).not.toContain('addressLine');
    }
  });
});
