/**
 * The rider's calls and the delivery sequence.
 */

import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import { completeDelivery, headingToPickup, nextStep, reportLocation, respondToOffer } from './rider';

function fakeClient(answer: unknown = {}) {
  const calls: { path: string; options: RequestOptions }[] = [];
  const api = {
    configured: true,
    request: async (path: string, options: RequestOptions = {}) => {
      calls.push({ path, options });
      return answer;
    },
    restore: async () => 'authenticated',
    signOut: async () => undefined,
  } as unknown as ApiClient;
  return { api, calls };
}

describe('the delivery sequence', () => {
  it('walks the server’s states in order and ends with the PIN', () => {
    const order = ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route'];
    const targets = order.map((status) => {
      const step = nextStep(status);
      return step?.kind === 'progress' ? step.to : null;
    });
    expect(targets).toEqual(['rider_arrived', 'picked_up', 'en_route', 'arrived']);
    expect(nextStep('arrived')?.kind).toBe('complete');
    expect(nextStep('delivered')).toBeNull();
    expect(nextStep('cancelled')).toBeNull();
  });

  it('navigates to the shop until the order is picked up', () => {
    expect(headingToPickup('rider_assigned')).toBe(true);
    expect(headingToPickup('rider_arrived')).toBe(true);
    expect(headingToPickup('picked_up')).toBe(false);
  });
});

describe('what the rider sends', () => {
  it('reports only plausible sensor values, with a timestamp', async () => {
    const { api, calls } = fakeClient();
    await reportLocation(api, { latitude: 6.5, longitude: 3.4, accuracy: 12, heading: -1, speed: 999 });
    const body = calls[0]!.options.body as Record<string, unknown>;
    expect(body).toMatchObject({ latitude: 6.5, longitude: 3.4, accuracy: 12 });
    expect(body).not.toHaveProperty('heading');
    expect(body).not.toHaveProperty('speed');
    expect(typeof body['recordedAt']).toBe('string');
  });

  it('accepts or declines by id, encoded', async () => {
    const { api, calls } = fakeClient({ accepted: true, orderId: 'o1' });
    await respondToOffer(api, 'a/b', true);
    await respondToOffer(api, 'c', false, 'Too far');
    expect(calls[0]).toMatchObject({ path: '/v1/rider/offers/a%2Fb/respond', options: { method: 'POST', body: { accept: true } } });
    expect(calls[1]!.options.body).toEqual({ accept: false, declineReason: 'Too far' });
  });

  it('completes with the PIN the customer reads out', async () => {
    const { api, calls } = fakeClient();
    await completeDelivery(api, 'o1', '4821', { latitude: 6.5, longitude: 3.4 });
    expect(calls[0]).toMatchObject({ path: '/v1/rider/deliveries/o1/complete', options: { body: { pin: '4821', latitude: 6.5, longitude: 3.4 } } });
  });
});
