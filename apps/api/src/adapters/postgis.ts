/**
 * PostGIS-backed geography.
 *
 * The port comment on `GeoPort.zonesContaining` has always said "the local
 * implementation tests polygons in process; the PostGIS one uses
 * `ST_Contains`". This is that implementation.
 *
 * **No schema change.** PostGIS is used as a query capability, not a column
 * type: geometry is built per query from the `polygon` text the schema already
 * stores. That keeps `schema.prisma` and `postgres/schema.prisma` byte-identical
 * apart from the datasource provider, keeps the Prisma drift check meaningful,
 * and means nothing about the domain models had to be redesigned. The cost is
 * that there is no GiST index on a materialised geometry column — see the
 * pre-filter below for why that is affordable, and RUNBOOKS for when it would
 * stop being.
 *
 * **What is actually better than the local adapter.** Two things, and it is
 * worth being precise because "we use PostGIS now" is not itself a benefit:
 *
 *   1. The containment test is PostGIS's own topological predicate rather than
 *      a hand-written ray cast. Rays that graze a vertex, self-touching rings,
 *      and holes are the cases a ray cast gets subtly wrong.
 *   2. The bounding-box pre-filter runs *in the database* against indexed
 *      columns. The local adapter loads every zone in the city and filters in
 *      JavaScript; this loads only the candidates whose box already contains
 *      the point.
 *
 * Routing and geocoding are not PostGIS's job, so those three methods delegate
 * unchanged to whichever adapter was configured for them.
 */

import {
  parsePolygon,
  pointToWkt,
  polygonToWkt,
  GeoError,
  type LatLng,
} from '@dash/domain/geo';
import type { GeocodeResult, GeoPort, RouteEstimate } from '@dash/domain/ports';
import type { PrismaClient } from '@dash/db';

/** SRID 4326 — WGS 84, the coordinate system every GPS fix and map tile uses. */
const SRID = 4326;

interface ZoneCandidate {
  id: string;
  polygon: string;
}

export class PostgisGeoAdapter implements GeoPort {
  readonly providerName = 'postgis';
  readonly isLive = true;

  constructor(
    private readonly prisma: PrismaClient,
    /**
     * Handles the methods PostGIS has no answer for. In practice the local
     * adapter, so routing stays haversine-with-detour until a real maps
     * provider is wired in.
     */
    private readonly delegate: GeoPort,
    private readonly log?: { warn: (payload: unknown, message: string) => void },
  ) {}

  route(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    return this.delegate.route(from, to);
  }

  geocode(query: string, near?: LatLng): Promise<readonly GeocodeResult[]> {
    return this.delegate.geocode(query, near);
  }

  reverseGeocode(point: LatLng): Promise<GeocodeResult | null> {
    return this.delegate.reverseGeocode(point);
  }

  /**
   * Zones whose polygon contains the point, best match first.
   *
   * Deliberately **not** filtered by `isActive`, exactly as the local adapter
   * documents: this answers the geometric question and leaves policy to the
   * caller. Filtering here once made `/v1/serviceability`'s `zone_paused`
   * branch unreachable, telling a customer in a temporarily paused area that
   * DASH APP does not deliver to them at all.
   */
  async zonesContaining(point: LatLng, cityId: string): Promise<readonly string[]> {
    // Indexed pre-filter, in the database. A zone whose bounding box excludes
    // the point cannot contain it, and this is a plain B-tree comparison.
    const candidates = await this.prisma.$queryRaw<ZoneCandidate[]>`
      SELECT "id", "polygon"
      FROM "Zone"
      WHERE "cityId" = ${cityId}
        AND "minLatitude"  <= ${point.latitude}
        AND "maxLatitude"  >= ${point.latitude}
        AND "minLongitude" <= ${point.longitude}
        AND "maxLongitude" >= ${point.longitude}
    `;

    if (candidates.length === 0) return [];

    // Geometry is built from the stored ring by the domain's own parser, which
    // already handles both the bare-ring and { outer, holes } encodings and is
    // exhaustively tested. A zone with an unparseable polygon is skipped and
    // logged rather than failing the whole lookup — one malformed row must not
    // make a city unserviceable.
    const usable: { id: string; wkt: string }[] = [];
    for (const candidate of candidates) {
      try {
        usable.push({
          id: candidate.id,
          wkt: polygonToWkt(parsePolygon(JSON.parse(candidate.polygon))),
        });
      } catch (error) {
        this.log?.warn(
          { zoneId: candidate.id, reason: error instanceof GeoError ? error.message : 'unparseable' },
          'skipping a zone whose stored polygon could not be read',
        );
      }
    }

    if (usable.length === 0) return [];

    const pointWkt = pointToWkt(point);

    // One round trip for every candidate. Both geometries are bound
    // parameters, so nothing about a stored polygon can alter the statement.
    const contained = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT z."id"
      FROM UNNEST(
             ${usable.map((zone) => zone.id)}::text[],
             ${usable.map((zone) => zone.wkt)}::text[]
           ) AS z("id", "wkt")
      WHERE ST_Contains(
              ST_SetSRID(ST_GeomFromText(z."wkt"), ${SRID}),
              ST_SetSRID(ST_GeomFromText(${pointWkt}), ${SRID})
            )
    `;

    // Preserve the candidate ordering the pre-filter returned, so the
    // "best match first" contract does not depend on PostgreSQL's row order.
    const matched = new Set(contained.map((row) => row.id));
    return usable.filter((zone) => matched.has(zone.id)).map((zone) => zone.id);
  }
}
