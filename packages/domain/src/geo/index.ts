/**
 * Geography.
 *
 * Pure geometry with no database and no map vendor. This is the `local`
 * implementation of the geo behaviour described in ADR-0003; a PostGIS-backed
 * implementation of the same `GeoPort` interface (see ../ports) uses
 * `ST_Contains` / `ST_DWithin` instead and is selected by `MAPS_PROVIDER`.
 *
 * Coordinates are always [longitude, latitude] in arrays (GeoJSON order) and
 * always named explicitly in objects, because silently swapping the two is the
 * classic geo bug and Lagos (6.5°N, 3.4°E) is close enough to the equator that
 * a swap still produces plausible-looking numbers.
 */

export interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

/** GeoJSON-order coordinate pair: [longitude, latitude]. */
export type Position = readonly [longitude: number, latitude: number];

/**
 * A closed ring of positions. The first and last point need not be identical —
 * the ring is treated as closed either way.
 */
export type Ring = readonly Position[];

export interface Polygon {
  /** Outer boundary. */
  readonly outer: Ring;
  /** Optional holes cut out of the outer boundary (e.g. a lagoon inside a zone). */
  readonly holes?: readonly Ring[];
}

export interface BoundingBox {
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minLongitude: number;
  readonly maxLongitude: number;
}

export class GeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoError';
  }
}

/** Mean Earth radius (WGS-84 authalic), metres. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Reject coordinates that cannot exist before they reach a distance calculation.
 * Rider clients are untrusted (see docs/SECURITY.md) and a GPS glitch reporting
 * lat 91 must be a validation failure, not a silent NaN downstream.
 */
export function assertValidLatLng(point: LatLng): void {
  const { latitude, longitude } = point;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new GeoError(`Coordinates must be finite, received ${latitude},${longitude}`);
  }
  if (latitude < -90 || latitude > 90) {
    throw new GeoError(`Latitude ${latitude} is outside [-90, 90]`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new GeoError(`Longitude ${longitude} is outside [-180, 180]`);
  }
}

export function isValidLatLng(point: LatLng): boolean {
  try {
    assertValidLatLng(point);
    return true;
  } catch {
    return false;
  }
}

/**
 * Great-circle distance in metres, via the haversine formula.
 *
 * Haversine rather than Vincenty: it is numerically stable at short distances,
 * has no iteration that can fail to converge, and its ~0.3% spheroid error is
 * far smaller than the error already introduced by using straight-line distance
 * as a proxy for road distance. When a routing provider is configured, road
 * distance from `GeoPort.route()` supersedes this for pricing.
 */
export function haversineMetres(from: LatLng, to: LatLng): number {
  assertValidLatLng(from);
  assertValidLatLng(to);

  const dLat = toRadians(to.latitude - from.latitude);
  const dLng = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Convenience wrapper — most callers think in kilometres. */
export function haversineKm(from: LatLng, to: LatLng): number {
  return haversineMetres(from, to) / 1000;
}

/**
 * Straight-line distance scaled by a detour factor to approximate road distance.
 *
 * The factor is a configured constant per city, not a guess baked into code: a
 * dense grid and a lagoon-crossing city have very different ratios. Lagos
 * defaults to 1.4 in the seed data. This is used only when no routing provider
 * is configured, and pricing records which method produced the distance so a
 * quote can be explained later.
 */
export function estimatedRoadMetres(from: LatLng, to: LatLng, detourFactor: number): number {
  if (!Number.isFinite(detourFactor) || detourFactor < 1) {
    throw new GeoError(`Detour factor must be >= 1, received ${detourFactor}`);
  }
  return haversineMetres(from, to) * detourFactor;
}

/**
 * Point-in-polygon by ray casting (crossing number).
 *
 * A horizontal ray is cast east from the point; an odd number of edge crossings
 * means inside. Points inside a hole are outside the polygon.
 *
 * Boundary behaviour is deliberately *inclusive*: a customer standing exactly on
 * a zone border is served rather than rejected. Refusing an order over a
 * floating-point tie is a worse outcome than serving one metre outside a zone.
 */
export function isPointInPolygon(point: LatLng, polygon: Polygon): boolean {
  assertValidLatLng(point);
  if (polygon.outer.length < 3) {
    throw new GeoError('A polygon ring needs at least 3 positions');
  }

  if (isPointOnAnyEdge(point, polygon.outer)) return true;
  if (!isPointInRing(point, polygon.outer)) return false;

  for (const hole of polygon.holes ?? []) {
    if (hole.length < 3) continue;
    if (isPointOnAnyEdge(point, hole)) return true; // on a hole's edge = still served
    if (isPointInRing(point, hole)) return false;
  }
  return true;
}

function isPointInRing(point: LatLng, ring: Ring): boolean {
  const { latitude: y, longitude: x } = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;

    const [xi, yi] = a;
    const [xj, yj] = b;

    // Does the edge straddle the ray's latitude? Using a strict/non-strict pair
    // means a vertex exactly at the ray's latitude is counted once, not twice.
    const straddles = yi > y !== yj > y;
    if (!straddles) continue;

    // Longitude where this edge crosses the point's latitude.
    const crossingX = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < crossingX) inside = !inside;
  }
  return inside;
}

/** Tolerance for "on the edge", in degrees. ~1cm at the equator. */
const EDGE_EPSILON = 1e-9;

function isPointOnAnyEdge(point: LatLng, ring: Ring): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (isPointOnSegment(point, a, b)) return true;
  }
  return false;
}

function isPointOnSegment(point: LatLng, a: Position, b: Position): boolean {
  const [ax, ay] = a;
  const [bx, by] = b;
  const { latitude: py, longitude: px } = point;

  // Cross product ~ 0 means collinear.
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > EDGE_EPSILON) return false;

  // Collinear — now check it falls within the segment's extent, not beyond it.
  const withinX = px >= Math.min(ax, bx) - EDGE_EPSILON && px <= Math.max(ax, bx) + EDGE_EPSILON;
  const withinY = py >= Math.min(ay, by) - EDGE_EPSILON && py <= Math.max(ay, by) + EDGE_EPSILON;
  return withinX && withinY;
}

/**
 * Bounding box of a polygon. Used as a cheap pre-filter: testing a box is far
 * cheaper than ray casting, so serviceability checks reject most zones on the
 * box before running the exact test.
 */
export function boundingBoxOf(polygon: Polygon): BoundingBox {
  if (polygon.outer.length === 0) throw new GeoError('Cannot bound an empty polygon');

  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;

  for (const [lng, lat] of polygon.outer) {
    if (lat < minLatitude) minLatitude = lat;
    if (lat > maxLatitude) maxLatitude = lat;
    if (lng < minLongitude) minLongitude = lng;
    if (lng > maxLongitude) maxLongitude = lng;
  }
  return { minLatitude, maxLatitude, minLongitude, maxLongitude };
}

export function isPointInBoundingBox(point: LatLng, box: BoundingBox): boolean {
  return (
    point.latitude >= box.minLatitude &&
    point.latitude <= box.maxLatitude &&
    point.longitude >= box.minLongitude &&
    point.longitude <= box.maxLongitude
  );
}

/**
 * Parse a zone polygon as stored in the database: JSON `[[lng, lat], ...]` for
 * the outer ring, optionally `{ outer, holes }`. Kept here so the shape of
 * persisted geometry is defined in exactly one place.
 */
export function parsePolygon(value: unknown): Polygon {
  if (Array.isArray(value)) return { outer: parseRing(value) };

  if (value && typeof value === 'object' && 'outer' in value) {
    const record = value as { outer: unknown; holes?: unknown };
    const outer = parseRing(record.outer);
    if (record.holes === undefined) return { outer };
    if (!Array.isArray(record.holes)) throw new GeoError('Polygon holes must be an array');
    return { outer, holes: record.holes.map(parseRing) };
  }
  throw new GeoError('Polygon must be a ring array or { outer, holes }');
}

function parseRing(value: unknown): Ring {
  if (!Array.isArray(value)) throw new GeoError('A polygon ring must be an array');
  if (value.length < 3) throw new GeoError('A polygon ring needs at least 3 positions');

  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new GeoError(`Ring position ${index} must be [longitude, latitude]`);
    }
    const [lng, lat] = entry as [unknown, unknown];
    if (typeof lng !== 'number' || typeof lat !== 'number') {
      throw new GeoError(`Ring position ${index} must hold two numbers`);
    }
    assertValidLatLng({ latitude: lat, longitude: lng });
    return [lng, lat] as Position;
  });
}

/**
 * Detect a physically impossible jump between two rider location pings.
 *
 * A rider reporting a position 40km from their last ping two seconds ago is
 * either spoofing or suffering GPS multipath. Either way the point must not
 * enter the tracking stream or the distance-based pay calculation.
 *
 * Returns the implied speed so the caller can log *why* it rejected the point.
 */
export interface LocationJumpCheck {
  readonly acceptable: boolean;
  readonly metres: number;
  readonly seconds: number;
  readonly impliedMetresPerSecond: number;
}

export function checkLocationJump(
  previous: LatLng,
  previousAt: Date,
  next: LatLng,
  nextAt: Date,
  maxMetresPerSecond: number,
): LocationJumpCheck {
  const metres = haversineMetres(previous, next);
  const seconds = (nextAt.getTime() - previousAt.getTime()) / 1000;

  // Out-of-order or duplicate timestamps: accept only a near-stationary point,
  // since we cannot compute a speed to judge it by.
  if (seconds <= 0) {
    return {
      acceptable: metres < 50,
      metres,
      seconds,
      impliedMetresPerSecond: Number.POSITIVE_INFINITY,
    };
  }

  const impliedMetresPerSecond = metres / seconds;
  return {
    acceptable: impliedMetresPerSecond <= maxMetresPerSecond,
    metres,
    seconds,
    impliedMetresPerSecond,
  };
}

/**
 * Round a coordinate for storage or display at reduced precision.
 *
 * Used to blur a customer's exact position in analytics and in the ops live map
 * before a rider is assigned. 4 decimal places is ~11m — enough to place someone
 * on the right street, not enough to place them in a specific flat.
 */
export function coarsen(point: LatLng, decimals = 4): LatLng {
  assertValidLatLng(point);
  const factor = 10 ** decimals;
  return {
    latitude: Math.round(point.latitude * factor) / factor,
    longitude: Math.round(point.longitude * factor) / factor,
  };
}

// ---------------------------------------------------------------------------
// Well-Known Text
//
// The serialisation PostGIS reads. It lives here, in pure code, rather than
// being assembled inside a SQL string in the adapter: building geometry by
// concatenating SQL is how coordinate-order bugs and injection holes both get
// in, and a pure function can be tested exhaustively without a database —
// which matters because this machine has no PostgreSQL to test against.
// ---------------------------------------------------------------------------

/** A ring, closed if it was not already. WKT requires first and last to match. */
function closedRing(ring: Ring): readonly Position[] {
  if (ring.length < 3) {
    throw new GeoError('A polygon ring needs at least 3 positions');
  }
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/**
 * Format one coordinate for WKT.
 *
 * Rejects anything non-finite rather than emitting `NaN` or `Infinity`, which
 * PostGIS would either reject with an opaque error or silently coerce.
 */
function wktNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new GeoError(`Coordinate ${String(value)} is not a finite number`);
  }
  return String(value);
}

function ringToWkt(ring: Ring): string {
  const positions = closedRing(ring)
    .map(([longitude, latitude]) => `${wktNumber(longitude)} ${wktNumber(latitude)}`)
    .join(', ');
  return `(${positions})`;
}

/**
 * A polygon as WKT, in `POLYGON((outer),(hole),(hole))` form.
 *
 * Positions stay in [longitude, latitude] order, which is both GeoJSON order
 * and WKT order — no swap happens here, and a test asserts that a deliberately
 * asymmetric polygon survives with longitude first.
 *
 * The output contains only digits, `.`, `-`, `,`, spaces, and parentheses, so
 * it cannot terminate a SQL string literal. It is nonetheless passed to
 * PostGIS as a bound parameter, never interpolated.
 */
export function polygonToWkt(polygon: Polygon): string {
  const rings = [polygon.outer, ...(polygon.holes ?? [])];
  return `POLYGON(${rings.map(ringToWkt).join(',')})`;
}

/** A point as WKT: `POINT(longitude latitude)`. */
export function pointToWkt(point: LatLng): string {
  assertValidLatLng(point);
  return `POINT(${wktNumber(point.longitude)} ${wktNumber(point.latitude)})`;
}
