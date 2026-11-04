import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { buildWorld } from './world.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
  await buildWorld(context.prisma);
});

afterAll(async () => {
  await context.close();
});

const get = (url: string) => context.app.inject({ method: 'GET', url });

describe('stable service-category API contract', () => {
  it('returns all six categories in the locked order without authentication', async () => {
    const response = await get('/v1/service-categories');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      categories: [
        { id: 'food', label: 'FOOD', kind: 'merchant', position: 1 },
        { id: 'shops', label: 'SHOPS', kind: 'merchant', position: 2 },
        { id: 'pharmacy', label: 'PHARMACY', kind: 'merchant', position: 3 },
        { id: 'local_market', label: 'LOCAL MARKET', kind: 'merchant', position: 4 },
        { id: 'declutter', label: 'DECLUTTER', kind: 'marketplace', position: 5 },
        { id: 'logistics', label: 'LOGISTICS', kind: 'logistics', position: 6 },
      ],
    });
  });

  it('maps the canonical food service to existing restaurant vendors', async () => {
    const response = await get('/v1/vendors?service=food');
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      vendors: { category: string; serviceCategory: string | null }[];
    }>();
    expect(body.vendors.length).toBeGreaterThan(0);
    expect(body.vendors.every(({ category }) => category === 'restaurant')).toBe(true);
    expect(body.vendors.every(({ serviceCategory }) => serviceCategory === 'food')).toBe(true);
  });

  it('keeps the legacy category filter working during migration', async () => {
    const response = await get('/v1/vendors?category=restaurant');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ vendors: unknown[] }>().vendors.length).toBeGreaterThan(0);
  });

  it('rejects ambiguous or non-merchant vendor filters', async () => {
    for (const query of [
      'service=food&category=restaurant',
      'service=declutter',
      'service=logistics',
      'service=groceries',
    ]) {
      const response = await get(`/v1/vendors?${query}`);
      expect(response.statusCode, query).toBe(400);
    }
  });
});
