/**
 * The PostGIS geo adapter, tested without PostgreSQL.
 *
 * What can honestly be asserted here is everything up to the moment the SQL
 * leaves the process: which query is issued, what geometry is built from a
 * stored polygon, that coordinates keep their order, that a malformed row is
 * survived rather than fatal, and that routing and geocoding are delegated
 * untouched. Prisma is substituted with a recorder, so these are real
 * assertions about real adapter behaviour rather than assertions about a mock.
 *
 * What cannot be asserted here is that PostGIS agrees with the local adapter
 * about containment. That needs a database and is `scripts/postgis-check.mjs`,
 * reported as PENDING until it has been run against a real server.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LatLng } from '@dash/domain/geo';
import type { GeocodeResult, GeoPort, RouteEstimate } from '@dash/domain/ports';
import type { PrismaClient } from '@dash/db';
import { PostgisGeoAdapter } from '../adapters/postgis.js';

/** A square over Lagos, in the [longitude, latitude] order the schema stores. */
const SQUARE = [
  [3.3, 6.4],
  [3.6, 6.4],
  [3.6, 6.7],
  [3.3, 6.7],
];

const INSIDE: LatLng = { latitude: 6.5, longitude: 3.4 };

/** Records what the adapter asked the database, and answers with a script. */
function recordingPrisma(responses: unknown[][]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let call = 0;

  const $queryRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), values });
    return Promise.resolve(responses[call++] ?? []);
  });

  return { prisma: { $queryRaw } as unknown as PrismaClient, calls };
}

/** A delegate that fails loudly if PostGIS tries to answer a non-spatial question itself. */
function stubDelegate(): GeoPort & { routeCalls: number } {
  const delegate = {
    providerName: 'stub',
    isLive: false,
    routeCalls: 0,
    async route(): Promise<RouteEstimate> {
      delegate.routeCalls += 1;
      return {
        distanceMetres: 1234,
        durationSeconds: 190,
        source: 'haversine_with_detour_factor',
      };
    },
    async geocode(): Promise<readonly GeocodeResult[]> {
      return [{ formattedAddress: 'delegated', location: INSIDE, confidence: 'high' }];
    },
    async reverseGeocode(): Promise<GeocodeResult | null> {
      return { formattedAddress: 'delegated-reverse', location: INSIDE, confidence: 'high' };
    },
    async zonesContaining(): Promise<readonly string[]> {
      throw new Error('the delegate must never be asked for zone containment');
    },
  };
  return delegate;
}

describe('zone containment', () => {
  it('pre-filters on the indexed bounding box in the database', async () => {
    const { prisma, calls } = recordingPrisma([[]]);
    await new PostgisGeoAdapter(prisma, stubDelegate()).zonesContaining(INSIDE, 'city_1');

    expect(calls).toHaveLength(1);
    const [prefilter] = calls;
    // The point of the pre-filter is that it is a plain B-tree comparison the
    // database can index, not a spatial operation.
    expect(prefilter!.sql).toContain('"minLatitude"');
    expect(prefilter!.sql).toContain('"maxLongitude"');
    expect(prefilter!.sql).not.toContain('ST_Contains');
    // City, then the point twice per axis — all bound, none interpolated.
    expect(prefilter!.values).toEqual(['city_1', 6.5, 6.5, 3.4, 3.4]);
  });

  it('does not touch the database a second time when nothing pre-matches', async () => {
    const { prisma, calls } = recordingPrisma([[]]);
    const zones = await new PostgisGeoAdapter(prisma, stubDelegate()).zonesContaining(
      INSIDE,
      'city_1',
    );
    expect(zones).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('asks PostGIS for the containment test, with both geometries bound', async () => {
    const { prisma, calls } = recordingPrisma([
      [{ id: 'zone_1', polygon: JSON.stringify(SQUARE) }],
      [{ id: 'zone_1' }],
    ]);

    const zones = await new PostgisGeoAdapter(prisma, stubDelegate()).zonesContaining(
      INSIDE,
      'city_1',
    );
    expect(zones).toEqual(['zone_1']);

    const [, containment] = calls;
    expect(containment!.sql).toContain('ST_Contains');
    expect(containment!.sql).toContain('ST_SetSRID');

    // The WKT is a bound parameter, never spliced into the statement.
    const flat = containment!.values.flat();
    expect(flat).toContain('POLYGON((3.3 6.4, 3.6 6.4, 3.6 6.7, 3.3 6.7, 3.3 6.4))');
    expect(flat).toContain('POINT(3.4 6.5)');
    expect(containment!.sql).not.toContain('POLYGON');
  });

  it('keeps longitude first when it builds the geometry', async () => {
    const { prisma, calls } = recordingPrisma([
      [{ id: 'zone_1', polygon: JSON.stringify(SQUARE) }],
      [],
    ]);
    await new PostgisGeoAdapter(prisma, stubDelegate()).zonesContaining(INSIDE, 'city_1');

    // 3.4 is the longitude and 6.5 the latitude; a swap here would place the
    // point off the coast of Somalia and still look like a plausible pair.
    expect(calls[1]!.values.flat()).toContain('POINT(3.4 6.5)');
  });

  it('skips a zone whose stored polygon cannot be read, and says so', async () => {
    const warn = vi.fn();
    const { prisma, calls } = recordingPrisma([
      [
        { id: 'zone_broken', polygon: 'not json at all' },
        { id: 'zone_ok', polygon: JSON.stringify(SQUARE) },
      ],
      [{ id: 'zone_ok' }],
    ]);

    const zones = await new PostgisGeoAdapter(prisma, stubDelegate(), { warn }).zonesContaining(
      INSIDE,
      'city_1',
    );

    // One malformed row must not make a whole city unserviceable.
    expect(zones).toEqual(['zone_ok']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(calls[1]!.values.flat().join(' ')).not.toContain('zone_broken');
  });

  it('returns nothing rather than querying when every candidate is malformed', async () => {
    const { prisma, calls } = recordingPrisma([[{ id: 'zone_broken', polygon: '{{{' }]]);
    const zones = await new PostgisGeoAdapter(prisma, stubDelegate(), { warn: vi.fn() })
      .zonesContaining(INSIDE, 'city_1');
    expect(zones).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('preserves the pre-filter ordering rather than the database row order', async () => {
    const { prisma } = recordingPrisma([
      [
        { id: 'zone_a', polygon: JSON.stringify(SQUARE) },
        { id: 'zone_b', polygon: JSON.stringify(SQUARE) },
      ],
      // PostgreSQL is free to return these in any order.
      [{ id: 'zone_b' }, { id: 'zone_a' }],
    ]);

    const zones = await new PostgisGeoAdapter(prisma, stubDelegate()).zonesContaining(
      INSIDE,
      'city_1',
    );
    expect(zones).toEqual(['zone_a', 'zone_b']);
  });

  it('handles a polygon stored in { outer, holes } form', async () => {
    const { prisma, calls } = recordingPrisma([
      [
        {
          id: 'zone_1',
          polygon: JSON.stringify({
            outer: SQUARE,
            holes: [[[3.4, 6.5], [3.5, 6.5], [3.5, 6.6]]],
          }),
        },
      ],
      [{ id: 'zone_1' }],
    ]);

    await new PostgisGeoAdapter(prisma, stubDelegate()).zonesContaining(INSIDE, 'city_1');
    const wkt = calls[1]!.values.flat().find((v) => String(v).startsWith('POLYGON'));
    expect(String(wkt)).toContain('),(');
  });

  it('does not filter by isActive — that is the caller\'s policy, not geometry', async () => {
    // Filtering here once made `/v1/serviceability`'s `zone_paused` branch
    // unreachable, so a customer in a temporarily paused area was told DASH APP
    // does not deliver to them at all.
    const { prisma, calls } = recordingPrisma([[]]);
    await new PostgisGeoAdapter(prisma, stubDelegate()).zonesContaining(INSIDE, 'city_1');
    expect(calls[0]!.sql).not.toContain('isActive');
  });
});

describe('everything PostGIS cannot answer is delegated', () => {
  it('delegates routing untouched', async () => {
    const delegate = stubDelegate();
    const { prisma, calls } = recordingPrisma([]);
    const estimate = await new PostgisGeoAdapter(prisma, delegate).route(INSIDE, INSIDE);

    expect(estimate.distanceMetres).toBe(1234);
    expect(delegate.routeCalls).toBe(1);
    // Routing is not a PostGIS question; it must not have touched the database.
    expect(calls).toHaveLength(0);
  });

  it('delegates geocoding and reverse geocoding', async () => {
    const { prisma } = recordingPrisma([]);
    const adapter = new PostgisGeoAdapter(prisma, stubDelegate());

    expect((await adapter.geocode('somewhere'))[0]?.formattedAddress).toBe('delegated');
    expect((await adapter.reverseGeocode(INSIDE))?.formattedAddress).toBe('delegated-reverse');
  });

  it('reports itself as a live provider', () => {
    const { prisma } = recordingPrisma([]);
    const adapter = new PostgisGeoAdapter(prisma, stubDelegate());
    expect(adapter.providerName).toBe('postgis');
    expect(adapter.isLive).toBe(true);
  });
});
