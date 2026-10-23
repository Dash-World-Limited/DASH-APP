// @vitest-environment jsdom

/**
 * "Can't complete this delivery" on the web rider page, which is what the
 * Android shell loads.
 *
 * The rules live on the server (POST /v1/rider/deliveries/:id/release, tested
 * in order-ops-controls.test.ts): before pickup only, a reason required, and
 * the next rider sent at once. These tests pin the client's side of that: the
 * action is offered only before pickup, it cannot be sent without a reason,
 * it is a deliberate second step, and a refusal is shown rather than lost.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/session', () => ({ authedFetch }));

const { RELEASE_REASONS, RiderReleaseDialog, riderCanRelease, riderCancelMode } = await import('./rider-release-dialog');

const DELIVERY = { id: 'order_1', code: 'DASH-ABC123' };

beforeEach(() => {
  authedFetch.mockReset();
  Reflect.deleteProperty(window, 'prompt');
  Reflect.deleteProperty(window, 'alert');
  Reflect.deleteProperty(window, 'confirm');
});

afterEach(cleanup);

describe('giving back a delivery from the web rider page', () => {
  it('is offered only before the rider has the order', () => {
    const statuses = ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived', 'delivered', 'cancelled'];
    expect(statuses.filter(riderCanRelease)).toEqual(['rider_assigned', 'rider_arrived']);
  });

  it('will not send without a reason', () => {
    render(<RiderReleaseDialog delivery={DELIVERY} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel delivery' }).disabled).toBe(true);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('sends the chosen reason to the shared release route, then refreshes', async () => {
    authedFetch.mockResolvedValue({ released: true, status: 'preparing' });
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<RiderReleaseDialog delivery={DELIVERY} onClose={onClose} onDone={onDone} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Problem with my vehicle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel delivery' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(authedFetch).toHaveBeenCalledWith('/v1/rider/deliveries/order_1/release', {
      method: 'POST',
      body: { reasonCode: 'vehicle_problem' },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server refusal after pickup and keeps the delivery', async () => {
    authedFetch.mockRejectedValue(
      new ApiRequestError(409, 'conflict', 'You already have this order, so it cannot be passed to another rider from the app. Contact DASH support now so they can arrange what happens to it.'),
    );
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<RiderReleaseDialog delivery={DELIVERY} onClose={onClose} onDone={onDone} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Personal emergency' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel delivery' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Contact DASH support/);
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('after pickup alerts DASH support and keeps the delivery, showing what to do', async () => {
    authedFetch.mockResolvedValue({ released: false, escalated: true, status: 'picked_up', message: 'DASH support has been alerted and will contact you.' });
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<RiderReleaseDialog delivery={DELIVERY} mode="escalate" onClose={onClose} onDone={onDone} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Problem with my vehicle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alert DASH support' }));

    expect((await screen.findByRole('status')).textContent).toMatch(/DASH support has been alerted/);
    expect(onDone).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(riderCancelMode('picked_up')).toBe('escalate');
    expect(riderCancelMode('rider_assigned')).toBe('release');
    expect(riderCancelMode('delivered')).toBeNull();
  });

  it('offers exactly the reasons the API accepts', () => {
    // Mirrors RELEASE_REASONS in apps/api/src/routes/rider.ts.
    expect(RELEASE_REASONS.map((reason) => reason.value)).toEqual([
      'vehicle_problem',
      'emergency',
      'vendor_closed_or_unreachable',
      'order_not_ready_too_long',
      'unsafe_location',
      'other',
    ]);
  });
});
