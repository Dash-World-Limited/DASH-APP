// @vitest-environment jsdom

/**
 * The two vendor actions that used to be browser prompts.
 *
 * Both were `window.prompt()`: rejecting an order asked the vendor to type a
 * number from one to five, and verifying a pickup asked them to type the
 * rider's code. In a sandboxed or embedded browser `prompt()` throws, and
 * because the call sat directly inside an `onClick`, the throw meant the
 * request was never sent and *nothing at all* was shown — the vendor pressed
 * Reject and the order stayed exactly where it was.
 *
 * So these tests assert the two things that failure had in common: that the
 * request actually goes out, and that the vendor is told what happened either
 * way. They render the real dialogs against a stubbed `authedFetch`, because
 * "the button sends the request" is a claim about a component.
 *
 * `prompt`, `alert` and `confirm` are deliberately left undefined on the jsdom
 * window below. Any reintroduction of one fails the suite rather than silently
 * working on a developer's machine and breaking in an embedded browser.
 */

import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/session', () => ({ authedFetch }));

const { PickupDialog, RejectDialog } = await import('./vendor-dialogs');

const ORDER = { id: 'order_1', code: 'DASH-ABC123' };

beforeEach(() => {
  authedFetch.mockReset();
  // The native dialogs must not exist. If a future edit reaches for one, the
  // component throws here and the test fails loudly.
  Reflect.deleteProperty(window, 'prompt');
  Reflect.deleteProperty(window, 'alert');
  Reflect.deleteProperty(window, 'confirm');
});

afterEach(cleanup);

describe('rejecting an order', () => {
  it('will not submit until a reason is chosen', () => {
    render(<RejectDialog order={ORDER} onClose={vi.fn()} onDone={vi.fn()} />);

    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Reject order' });
    expect(confirm.disabled).toBe(true);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('sends the chosen reason code the API expects', async () => {
    authedFetch.mockResolvedValue({ rejected: true });
    const onDone = vi.fn();
    const onClose = vi.fn();

    render(<RejectDialog order={ORDER} onClose={onClose} onDone={onDone} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Out of stock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject order' }));

    await waitFor(() => expect(authedFetch).toHaveBeenCalledTimes(1));
    expect(authedFetch).toHaveBeenCalledWith('/v1/vendor/orders/order_1/reject', {
      method: 'POST',
      body: { reasonCode: 'out_of_stock' },
    });

    // The queue is re-read and the dialog closes only after the server agreed.
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('offers every reason the API accepts', () => {
    render(<RejectDialog order={ORDER} onClose={vi.fn()} onDone={vi.fn()} />);

    // Mirrors the `reasonCode` enum on POST /v1/vendor/orders/:id/reject. A
    // reason the server refuses is worse than no reason at all: the vendor
    // believes the order is rejected and it is not.
    for (const label of [
      'Out of stock',
      'Too busy right now',
      'Closing soon',
      'Cannot meet the instructions',
      'Another reason',
    ]) {
      expect(screen.getByRole('radio', { name: label })).toBeTruthy();
    }
  });

  it('shows the failure and stays open so the vendor can retry', async () => {
    authedFetch.mockRejectedValue(
      new ApiRequestError(422, 'unprocessable', 'This order was already accepted.'),
    );
    const onClose = vi.fn();

    render(<RejectDialog order={ORDER} onClose={onClose} onDone={vi.fn()} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Closing soon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject order' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('already accepted');
    // The silent failure this replaces is the whole point of the test.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Closing soon' }).checked).toBe(true);
  });
});

describe('verifying a pickup code', () => {
  it('will not submit a code that is not four digits', () => {
    render(<PickupDialog order={ORDER} onClose={vi.fn()} onDone={vi.fn()} />);

    const verify = screen.getByRole<HTMLButtonElement>('button', { name: 'Verify' });
    expect(verify.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Rider's code"), { target: { value: '12' } });
    expect(verify.disabled).toBe(true);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('ignores anything that is not a digit', () => {
    render(<PickupDialog order={ORDER} onClose={vi.fn()} onDone={vi.fn()} />);

    const input = screen.getByLabelText("Rider's code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a1b2c3d4e5' } });

    expect(input.value).toBe('1234');
  });

  it('sends the code and confirms success on screen', async () => {
    authedFetch.mockResolvedValue({ verified: true });
    const onDone = vi.fn();

    render(<PickupDialog order={ORDER} onClose={vi.fn()} onDone={onDone} />);

    fireEvent.change(screen.getByLabelText("Rider's code"), { target: { value: '4733' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(authedFetch).toHaveBeenCalledTimes(1));
    expect(authedFetch).toHaveBeenCalledWith('/v1/vendor/orders/order_1/verify-pickup', {
      method: 'POST',
      body: { code: '4733' },
    });

    // Replaces a `window.alert`. The confirmation has to be visible in the
    // page, because that alert could not appear at all where prompt() threw.
    await screen.findByText('Code verified');
    expect(onDone).toHaveBeenCalled();
  });

  it('keeps the vendor on the step when the code is wrong', async () => {
    authedFetch.mockRejectedValue(
      new ApiRequestError(422, 'unprocessable', 'That pickup code is not correct.'),
    );
    const onClose = vi.fn();

    render(<PickupDialog order={ORDER} onClose={onClose} onDone={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Rider's code"), { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('not correct');
    expect(screen.queryByText('Code verified')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('both dialogs are reachable without a mouse', () => {
  it('names itself and takes focus', async () => {
    render(<RejectDialog order={ORDER} onClose={vi.fn()} onDone={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Named by its heading, so a screen reader announces which order this is.
    expect(screen.getByRole('heading', { name: /Reject DASH-ABC123/ })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<PickupDialog order={ORDER} onClose={onClose} onDone={vi.fn()} />);

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(onClose).toHaveBeenCalled();
  });
});
