/**
 * Saved addresses: editing, choosing the default and removing — each scoped to
 * the caller's own, live addresses. A removed address is archived (orders keep
 * pointing at it) and can no longer be priced or ordered to.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** A second saved address for customer A, written directly so no zone lookup is involved. */
async function extraAddress(overrides: Record<string, unknown> = {}) {
  return context.prisma.address.create({
    data: {
      customerId: world.customerA.customerId,
      label: 'Work',
      line1: '4 Nnebisi Road',
      landmark: 'Opposite the bank',
      contactPhone: '+2348031234567',
      latitude: 6.2,
      longitude: 6.7,
      ...overrides,
    },
  });
}

const patch = (id: string, payload: unknown, headers: Record<string, string> = customerA.headers) =>
  context.app.inject({ method: 'PATCH', url: `/v1/addresses/${id}`, headers, payload: payload as Record<string, unknown> });
const remove = (id: string, headers: Record<string, string> = customerA.headers) =>
  context.app.inject({ method: 'DELETE', url: `/v1/addresses/${id}`, headers });
const list = async (headers: Record<string, string> = customerA.headers) =>
  (await context.app.inject({ method: 'GET', url: '/v1/addresses', headers })).json<{ addresses: Array<{ id: string; isDefault: boolean }> }>().addresses;

describe('PATCH /v1/addresses/:id', () => {
  it('requires a session', async () => {
    const address = await extraAddress();
    expect((await patch(address.id, { label: 'Home' }, {})).statusCode).toBe(401);
  });

  it('edits the words of the caller’s own address and never its position', async () => {
    const address = await extraAddress();
    const response = await patch(address.id, { label: ' Office ', line1: '5 Nnebisi Road', landmark: '', instructions: 'Ring twice', contactPhone: '+2348039876543' });
    expect(response.statusCode).toBe(200);
    const row = await context.prisma.address.findUniqueOrThrow({ where: { id: address.id } });
    expect(row).toMatchObject({ label: 'Office', line1: '5 Nnebisi Road', landmark: null, instructions: 'Ring twice', contactPhone: '+2348039876543', latitude: 6.2, longitude: 6.7 });
  });

  it('makes one address the default and clears the others', async () => {
    const first = await extraAddress({ isDefault: true });
    const second = await extraAddress();
    expect((await patch(second.id, { isDefault: true })).statusCode).toBe(200);
    const defaults = await context.prisma.address.findMany({ where: { customerId: world.customerA.customerId, isDefault: true } });
    expect(defaults.map((row) => row.id)).toEqual([second.id]);
    expect((await context.prisma.address.findUniqueOrThrow({ where: { id: first.id } })).isDefault).toBe(false);
  });

  it('refuses someone else’s address as not found, and changes nothing', async () => {
    const before = await context.prisma.address.findUniqueOrThrow({ where: { id: world.customerB.addressId } });
    expect((await patch(world.customerB.addressId, { label: 'Mine now' })).statusCode).toBe(404);
    expect((await patch(world.customerB.addressId, { isDefault: true })).statusCode).toBe(404);
    expect(await context.prisma.address.findUniqueOrThrow({ where: { id: world.customerB.addressId } })).toEqual(before);
  });

  it('refuses positions, ownership changes, un-defaulting, bad phones and empty edits', async () => {
    const address = await extraAddress();
    for (const payload of [
      { latitude: 6.5 },
      { longitude: 3.4 },
      { customerId: world.customerB.customerId },
      { isDefault: false },
      { contactPhone: '0803 123 4567' },
      { line1: 'ab' },
      {},
    ]) {
      expect((await patch(address.id, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('DELETE /v1/addresses/:id', () => {
  it('archives the caller’s own address and takes it off the list and off default', async () => {
    const address = await extraAddress({ isDefault: true });
    expect((await remove(address.id)).statusCode).toBe(200);
    const row = await context.prisma.address.findUniqueOrThrow({ where: { id: address.id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.isDefault).toBe(false);
    expect((await list()).some((item) => item.id === address.id)).toBe(false);
    // Gone is gone: it cannot be removed, edited or made default again.
    expect((await remove(address.id)).statusCode).toBe(404);
    expect((await patch(address.id, { isDefault: true })).statusCode).toBe(404);
  });

  it('refuses someone else’s address', async () => {
    expect((await remove(world.customerA.addressId, customerB.headers)).statusCode).toBe(404);
    expect((await context.prisma.address.findUniqueOrThrow({ where: { id: world.customerA.addressId } })).archivedAt).toBeNull();
  });

  it('cannot be priced or ordered to once removed', async () => {
    const address = await extraAddress({ latitude: 6.52, longitude: 3.38 });
    await remove(address.id);
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: address.id,
      },
    });
    expect(response.statusCode).toBe(422);
  });
});
