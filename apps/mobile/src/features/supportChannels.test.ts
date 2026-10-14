/**
 * Which ways to reach DASH the Help screens offer, and how WhatsApp opens.
 */

import { describe, expect, it } from 'vitest';

import { DASH_SUPPORT_EMAIL, supportChannels, whatsappGreeting, whatsappUrl } from './support';

describe('support channels', () => {
  it('offers chat, then the official WhatsApp line, then email', () => {
    expect(supportChannels({ chat: true, whatsapp: '+2348000001234' })).toEqual([
      { kind: 'chat' },
      { kind: 'whatsapp', number: '+2348000001234' },
      { kind: 'email', address: DASH_SUPPORT_EMAIL },
    ]);
  });

  it('never shows WhatsApp without a valid official number', () => {
    for (const whatsapp of [null, '', '08000001234', '+0123', 'not a number', '+234 800 000 1234']) {
      expect(supportChannels({ chat: true, whatsapp }).map((channel) => channel.kind)).toEqual(['chat', 'email']);
    }
  });

  it('always keeps email, even when nothing else is available', () => {
    expect(supportChannels({ chat: false, whatsapp: null })).toEqual([{ kind: 'email', address: 'info@dashworldng.com' }]);
  });
});

describe('opening WhatsApp', () => {
  it('opens the official conversation with a first message ready to send', () => {
    const url = whatsappUrl('+2348000001234', whatsappGreeting('rider'));
    expect(url.startsWith('https://wa.me/2348000001234?text=')).toBe(true);
    expect(new URL(url).searchParams.get('text')).toBe('Hello DASH support, I am a DASH rider and I need help.');
    expect(new URL(whatsappUrl('+2348000001234', whatsappGreeting('customer'))).searchParams.get('text')).toContain('order or account');
  });

  it('opens a plain conversation when there is no first message', () => {
    expect(whatsappUrl('+2348000001234')).toBe('https://wa.me/2348000001234');
  });
});
