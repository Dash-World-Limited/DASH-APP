/**
 * Where a tapped push goes, whether one is shown while the app is open, and
 * when Android is asked for permission.
 */

import { describe, expect, it } from 'vitest';

import { createNavigationState, currentRoute, goBack, navigate, selectTab } from '../v2/navigation/model';
import { notificationTarget, openPushTarget, permissionStep, readPushData, showInForeground, type PushViewer } from './pushNotifications';

const customer: PushViewer = { customerId: 'cus_1', riderStatus: null };
const rider: PushViewer = { customerId: 'cus_2', riderStatus: 'approved' };
const applicant: PushViewer = { customerId: 'cus_3', riderStatus: 'pending' };

describe('reading a push', () => {
  it('understands each DASH push by its identifiers', () => {
    expect(readPushData({ type: 'order_update', audience: 'customer', orderId: 'ord_1', status: 'picked_up' })).toEqual({
      type: 'order_update',
      audience: 'customer',
      orderId: 'ord_1',
      status: 'picked_up',
    });
    // An offer is only ever for a rider, and says so by its type.
    expect(readPushData({ type: 'rider_offer', offerId: 'off_1', expiresAt: '2026-10-15T10:00:30.000Z' })).toEqual({
      type: 'rider_offer',
      audience: 'rider',
      offerId: 'off_1',
    });
  });

  it('refuses anything that is not a well-formed DASH push', () => {
    for (const raw of [
      null,
      'order_update',
      {},
      { type: 'marketing', audience: 'customer' },
      { type: 'order_update', audience: 'vendor', orderId: 'ord_1' },
      { type: 'order_update', audience: 'customer' },
      { type: 'order_chat', audience: 'rider', orderId: '../../admin' },
      { type: 'support_reply', audience: 'customer' },
    ]) {
      expect(readPushData(raw)).toBeNull();
    }
  });
});

describe('where a tapped push goes', () => {
  it('opens a customer’s order, its chat, or their support conversation', () => {
    expect(notificationTarget(readPushData({ type: 'order_update', audience: 'customer', orderId: 'ord_1' }), customer)).toEqual({
      face: 'customer',
      routes: [{ name: 'customer.track-order', params: { id: 'ord_1' } }],
    });
    expect(notificationTarget(readPushData({ type: 'payment_update', audience: 'customer', orderId: 'ord_1' }), customer)?.routes).toEqual([
      { name: 'customer.track-order', params: { id: 'ord_1' } },
    ]);
    expect(notificationTarget(readPushData({ type: 'order_chat', audience: 'customer', orderId: 'ord_1' }), customer)?.routes).toEqual([
      { name: 'customer.track-order', params: { id: 'ord_1' } },
      { name: 'customer.chat', params: { id: 'ord_1' } },
    ]);
    expect(notificationTarget(readPushData({ type: 'support_reply', audience: 'customer', conversationId: 'case_1' }), customer)).toEqual({
      face: 'customer',
      routes: [{ name: 'customer.support-chat' }],
    });
  });

  it('opens a rider’s live workspace, their delivery chat, their orders or their support conversation', () => {
    expect(notificationTarget(readPushData({ type: 'rider_offer', offerId: 'off_1' }), rider)).toEqual({ face: 'rider', routes: [{ name: 'rider.online' }] });
    expect(notificationTarget(readPushData({ type: 'order_chat', audience: 'rider', orderId: 'ord_1' }), rider)?.routes).toEqual([
      { name: 'rider.online' },
      { name: 'rider.chat', params: { id: 'ord_1' } },
    ]);
    expect(notificationTarget(readPushData({ type: 'order_update', audience: 'rider', orderId: 'ord_1', status: 'cancelled' }), rider)).toEqual({
      face: 'rider',
      routes: [{ name: 'rider.orders' }],
    });
    expect(notificationTarget(readPushData({ type: 'support_reply', audience: 'rider', conversationId: 'case_2' }), rider)?.routes).toEqual([
      { name: 'rider.support-chat' },
    ]);
  });

  it('opens nothing for a side of the app the signed-in account does not have, or for nobody', () => {
    const offer = readPushData({ type: 'rider_offer', offerId: 'off_1' });
    expect(notificationTarget(offer, customer)).toBeNull();
    expect(notificationTarget(offer, applicant)).toBeNull();
    expect(notificationTarget(offer, null)).toBeNull();
    expect(notificationTarget(readPushData({ type: 'order_update', audience: 'customer', orderId: 'o' }), { customerId: null, riderStatus: 'approved' })).toBeNull();
    expect(notificationTarget(null, customer)).toBeNull();
  });
});

describe('opening the target', () => {
  it('keeps the Rider face while an iOS active delivery is still restoring', () => {
    const restoring = createNavigationState('rider');
    const target = notificationTarget(readPushData({ type: 'payment_update', audience: 'customer', orderId: 'o' }), rider)!;
    expect(openPushTarget(restoring, target, { riderApproved: true, deliveryInProgress: false, deliveryRestoring: true })).toBeNull();
    // Once delivery state is known and idle, the existing face switch remains.
    expect(openPushTarget(restoring, target, { riderApproved: true, deliveryInProgress: false, deliveryRestoring: false })?.face).toBe('customer');
    // Restoration does not prevent opening a notification for the Rider face.
    const offer = notificationTarget(readPushData({ type: 'rider_offer', offerId: 'restoring_offer' }), rider)!;
    expect(openPushTarget(restoring, offer, { riderApproved: true, deliveryInProgress: false, deliveryRestoring: true })?.face).toBe('rider');
  });
  it('opens on top of what is showing on the same face, so Back returns there', () => {
    const wallet = selectTab(createNavigationState('customer'), { name: 'customer.wallet' });
    const target = notificationTarget(readPushData({ type: 'order_chat', audience: 'customer', orderId: 'ord_1' }), customer)!;
    const opened = openPushTarget(wallet, target, { riderApproved: false, deliveryInProgress: false })!;
    expect(currentRoute(opened)).toEqual({ name: 'customer.chat', params: { id: 'ord_1' } });
    expect(currentRoute(goBack(opened))).toEqual({ name: 'customer.track-order', params: { id: 'ord_1' } });
    expect(goBack(goBack(opened))).toEqual(wallet);
  });

  it('switches face for a push about the other side, and selects a tab as a tab', () => {
    const shopping = navigate(createNavigationState('customer'), { name: 'customer.search' });
    const target = notificationTarget(readPushData({ type: 'order_update', audience: 'rider', orderId: 'o', status: 'cancelled' }), rider)!;
    const opened = openPushTarget(shopping, target, { riderApproved: true, deliveryInProgress: false })!;
    expect(opened).toEqual({ face: 'rider', stack: [{ name: 'rider.orders' }] });
  });

  it('keeps a rider on a delivery in progress, and never opens the rider face for an unapproved account', () => {
    const delivering = navigate(createNavigationState('rider'), { name: 'rider.online' });
    const customerPush = notificationTarget(readPushData({ type: 'order_update', audience: 'customer', orderId: 'o' }), rider)!;
    expect(openPushTarget(delivering, customerPush, { riderApproved: true, deliveryInProgress: true })).toBeNull();
    expect(openPushTarget(delivering, customerPush, { riderApproved: true, deliveryInProgress: false })?.face).toBe('customer');

    const offer = { face: 'rider' as const, routes: [{ name: 'rider.online' as const }] };
    expect(openPushTarget(createNavigationState('customer'), offer, { riderApproved: false, deliveryInProgress: false })).toBeNull();
  });
});

describe('a push that arrives while the app is open', () => {
  const at = (face: 'customer' | 'rider', name: string, id?: string) => ({ face, route: { name, ...(id ? { params: { id } } : {}) } as never });

  it('is not shown when the screen already shows what it is about', () => {
    expect(showInForeground(readPushData({ type: 'order_chat', audience: 'customer', orderId: 'ord_1' }), at('customer', 'customer.chat', 'ord_1'))).toBe(false);
    expect(showInForeground(readPushData({ type: 'order_update', audience: 'customer', orderId: 'ord_1' }), at('customer', 'customer.track-order', 'ord_1'))).toBe(false);
    expect(showInForeground(readPushData({ type: 'support_reply', audience: 'rider', conversationId: 'c' }), at('rider', 'rider.support-chat'))).toBe(false);
    // The rider face shows a live offer banner everywhere.
    expect(showInForeground(readPushData({ type: 'rider_offer', offerId: 'off' }), at('rider', 'rider.earnings'))).toBe(false);
    expect(showInForeground(readPushData({ type: 'order_update', audience: 'rider', orderId: 'o', status: 'cancelled' }), at('rider', 'rider.online'))).toBe(false);
  });

  it('is shown everywhere else', () => {
    expect(showInForeground(readPushData({ type: 'order_chat', audience: 'customer', orderId: 'ord_1' }), at('customer', 'customer.chat', 'ord_2'))).toBe(true);
    expect(showInForeground(readPushData({ type: 'order_update', audience: 'customer', orderId: 'ord_1' }), at('customer', 'customer.home'))).toBe(true);
    expect(showInForeground(readPushData({ type: 'support_reply', audience: 'customer', conversationId: 'c' }), at('customer', 'customer.wallet'))).toBe(true);
    expect(showInForeground(readPushData({ type: 'rider_offer', offerId: 'off' }), at('customer', 'customer.home'))).toBe(true);
    expect(showInForeground(readPushData({ type: 'payment_update', audience: 'customer', orderId: 'o' }), at('customer', 'customer.track-order', 'o'))).toBe(true);
  });
});

describe('asking Android for permission', () => {
  const base = { granted: false, canAskAgain: true, enabled: true, askedBefore: false, userAsked: false };

  it('registers as soon as it is granted, whatever the switch says', () => {
    expect(permissionStep({ ...base, granted: true })).toBe('register');
    expect(permissionStep({ ...base, granted: true, enabled: false })).toBe('register');
  });

  it('asks once on its own, and again only when the person turns notifications on', () => {
    expect(permissionStep(base)).toBe('ask');
    expect(permissionStep({ ...base, askedBefore: true })).toBe('wait');
    expect(permissionStep({ ...base, askedBefore: true, userAsked: true })).toBe('ask');
  });

  it('never asks someone who switched notifications off, or whom Android will not let it ask', () => {
    expect(permissionStep({ ...base, enabled: false })).toBe('wait');
    expect(permissionStep({ ...base, canAskAgain: false, userAsked: true })).toBe('wait');
  });
});
