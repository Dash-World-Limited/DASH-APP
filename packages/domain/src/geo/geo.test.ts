import { describe, expect, it } from 'vitest';
import {
  assertValidLatLng,
  boundingBoxOf,
  checkLocationJump,
  coarsen,
  estimatedRoadMetres,
  GeoError,
  haversineKm,
  haversineMetres,
  isPointInBoundingBox,
  isPointInPolygon,
  isValidLatLng,
  parsePolygon,
  type LatLng,
  type Polygon,
} from './index.js';

// Real Lagos landmarks, used as fixtures because their true separations are
// known and a swapped lat/lng would produce an obviously wrong distance.
const IKEJA: LatLng = { latitude: 6.6018, longitude: 3.3515 };
const VICTORIA_ISLAND: LatLng = { latitude: 6.4281, longitude: 3.4219 };
const LEKKI_PHASE_1: LatLng = { latitude: 6.4478, longitude: 3.4723 };

describe('coordinate validation', () => {
  it('accepts valid coordinates', () => {
    expect(isValidLatLng(IKEJA)).toBe(true);
    expect(isValidLatLng({ latitude: 0, longitude: 0 })).toBe(true);
    expect(isValidLatLng({ latitude: -90, longitude: 180 })).toBe(true);
  });

  it('rejects out-of-range values — a GPS glitch must fail loudly', () => {
    expect(() => assertValidLatLng({ latitude: 91, longitude: 0 })).toThrow(GeoError);
    expect(() => assertValidLatLng({ latitude: 0, longitude: 181 })).toThrow(GeoError);
    expect(() => assertValidLatLng({ latitude: Number.NaN, longitude: 0 })).toThrow(GeoError);
    expect(() =>
      assertValidLatLng({ latitude: 0, longitude: Number.POSITIVE_INFINITY }),
    ).toThrow(GeoError);
  });
});

describe('haversine', () => {
  it('is zero for identical points', () => {
    expect(haversineMetres(IKEJA, IKEJA)).toBe(0);
  });

  it('matches known Lagos distances within 1%', () => {
    // Ikeja to Victoria Island is ~20km great-circle.
    const km = haversineKm(IKEJA, VICTORIA_ISLAND);
    expect(km).toBeGreaterThan(19);
    expect(km).toBeLessThan(21);
  });

  it('is symmetric', () => {
    expect(haversineMetres(IKEJA, LEKKI_PHASE_1)).toBeCloseTo(
      haversineMetres(LEKKI_PHASE_1, IKEJA),
      6,
    );
  });

  it('CANNOT detect swapped lat/lng by distance alone at Lagos latitude', () => {
    // This is the finding that justifies naming coordinates explicitly
    // everywhere instead of passing [a, b] pairs around.
    //
    // Lagos sits at ~6.4°N, ~3.4°E. Both values are small and similar, so
    // swapping them moves the point to (3.4°N, 6.4°E) — the Gulf of Guinea —
    // yet the distance between two *equally* swapped points barely changes.
    // A distance sanity-check would wave this straight through.
    const correct = haversineKm(VICTORIA_ISLAND, LEKKI_PHASE_1);
    const swapped = haversineKm(
      { latitude: VICTORIA_ISLAND.longitude, longitude: VICTORIA_ISLAND.latitude },
      { latitude: LEKKI_PHASE_1.longitude, longitude: LEKKI_PHASE_1.latitude },
    );
    expect(Math.abs(correct - swapped)).toBeLessThan(0.1);
  });

  it('DOES detect swapped lat/lng via serviceability — the check that matters', () => {
    // Serviceability is what actually catches the swap: the swapped point is
    // hundreds of kilometres out to sea and falls outside every zone.
    const lagosZone: Polygon = {
      outer: [
        [3.30, 6.40],
        [3.55, 6.40],
        [3.55, 6.65],
        [3.30, 6.65],
      ],
    };
    expect(isPointInPolygon(VICTORIA_ISLAND, lagosZone)).toBe(true);
    expect(
      isPointInPolygon(
        { latitude: VICTORIA_ISLAND.longitude, longitude: VICTORIA_ISLAND.latitude },
        lagosZone,
      ),
    ).toBe(false);
  });

  it('respects the triangle inequality', () => {
    const direct = haversineMetres(IKEJA, LEKKI_PHASE_1);
    const viaVi =
      haversineMetres(IKEJA, VICTORIA_ISLAND) + haversineMetres(VICTORIA_ISLAND, LEKKI_PHASE_1);
    expect(direct).toBeLessThanOrEqual(viaVi + 1);
  });
});

describe('estimatedRoadMetres', () => {
  it('scales straight-line distance by the detour factor', () => {
    const straight = haversineMetres(IKEJA, VICTORIA_ISLAND);
    expect(estimatedRoadMetres(IKEJA, VICTORIA_ISLAND, 1.4)).toBeCloseTo(straight * 1.4, 6);
  });

  it('rejects a factor below 1 — roads are never shorter than the crow flies', () => {
    expect(() => estimatedRoadMetres(IKEJA, VICTORIA_ISLAND, 0.9)).toThrow(GeoError);
  });
});

// A simple square around Victoria Island for polygon tests.
const SQUARE: Polygon = {
  outer: [
    [3.40, 6.41],
    [3.45, 6.41],
    [3.45, 6.45],
    [3.40, 6.45],
  ],
};

describe('isPointInPolygon', () => {
  it('finds points inside', () => {
    expect(isPointInPolygon({ latitude: 6.43, longitude: 3.42 }, SQUARE)).toBe(true);
  });

  it('rejects points outside', () => {
    expect(isPointInPolygon({ latitude: 6.50, longitude: 3.42 }, SQUARE)).toBe(false);
    expect(isPointInPolygon({ latitude: 6.43, longitude: 3.50 }, SQUARE)).toBe(false);
    expect(isPointInPolygon({ latitude: 6.40, longitude: 3.42 }, SQUARE)).toBe(false);
  });

  it('treats the boundary as inside — never refuse an order over a tie', () => {
    expect(isPointInPolygon({ latitude: 6.41, longitude: 3.42 }, SQUARE)).toBe(true);
    expect(isPointInPolygon({ latitude: 6.43, longitude: 3.40 }, SQUARE)).toBe(true);
  });

  it('treats vertices as inside', () => {
    expect(isPointInPolygon({ latitude: 6.41, longitude: 3.40 }, SQUARE)).toBe(true);
    expect(isPointInPolygon({ latitude: 6.45, longitude: 3.45 }, SQUARE)).toBe(true);
  });

  it('counts a vertex exactly on the ray only once', () => {
    // A point whose latitude equals a vertex latitude is the classic
    // double-counting bug in ray casting.
    const spiky: Polygon = {
      outer: [
        [3.40, 6.40],
        [3.50, 6.45],
        [3.60, 6.40],
        [3.60, 6.50],
        [3.40, 6.50],
      ],
    };
    expect(isPointInPolygon({ latitude: 6.45, longitude: 3.55 }, spiky)).toBe(true);
    expect(isPointInPolygon({ latitude: 6.45, longitude: 3.30 }, spiky)).toBe(false);
  });

  it('excludes points inside a hole', () => {
    const withHole: Polygon = {
      outer: SQUARE.outer,
      holes: [
        [
          [3.42, 6.42],
          [3.43, 6.42],
          [3.43, 6.43],
          [3.42, 6.43],
        ],
      ],
    };
    // Inside the hole → not served.
    expect(isPointInPolygon({ latitude: 6.425, longitude: 3.425 }, withHole)).toBe(false);
    // Inside the polygon but outside the hole → served.
    expect(isPointInPolygon({ latitude: 6.44, longitude: 3.44 }, withHole)).toBe(true);
  });

  it('rejects a degenerate ring', () => {
    expect(() =>
      isPointInPolygon(IKEJA, { outer: [[3.4, 6.4], [3.5, 6.5]] }),
    ).toThrow(GeoError);
  });
});

describe('bounding box', () => {
  it('bounds a polygon', () => {
    const box = boundingBoxOf(SQUARE);
    expect(box).toEqual({
      minLatitude: 6.41,
      maxLatitude: 6.45,
      minLongitude: 3.4,
      maxLongitude: 3.45,
    });
  });

  it('is a valid pre-filter — everything in the polygon is in the box', () => {
    const box = boundingBoxOf(SQUARE);
    for (let i = 0; i < 500; i += 1) {
      const point = {
        latitude: 6.38 + Math.random() * 0.1,
        longitude: 3.38 + Math.random() * 0.1,
      };
      if (isPointInPolygon(point, SQUARE)) {
        expect(isPointInBoundingBox(point, box)).toBe(true);
      }
    }
  });
});

describe('parsePolygon', () => {
  it('reads a bare ring array', () => {
    const polygon = parsePolygon([
      [3.4, 6.41],
      [3.45, 6.41],
      [3.45, 6.45],
    ]);
    expect(polygon.outer).toHaveLength(3);
  });

  it('reads an object with holes', () => {
    const polygon = parsePolygon({
      outer: SQUARE.outer,
      holes: [[[3.42, 6.42], [3.43, 6.42], [3.43, 6.43]]],
    });
    expect(polygon.holes).toHaveLength(1);
  });

  it('rejects malformed geometry rather than storing it', () => {
    expect(() => parsePolygon('not geometry')).toThrow(GeoError);
    expect(() => parsePolygon([[3.4, 6.4]])).toThrow(GeoError);
    expect(() => parsePolygon([[3.4], [3.5, 6.5], [3.6, 6.6]])).toThrow(GeoError);
    expect(() => parsePolygon([['a', 'b'], [3.5, 6.5], [3.6, 6.6]])).toThrow(GeoError);
    // Out-of-range coordinates must not survive parsing.
    expect(() => parsePolygon([[3.4, 91], [3.5, 6.5], [3.6, 6.6]])).toThrow(GeoError);
  });
});

describe('checkLocationJump', () => {
  const start = new Date('2026-08-30T10:00:00Z');
  // 25 m/s ≈ 90 km/h — generous for a Lagos okada, tight enough to catch spoofing.
  const MAX_SPEED = 25;

  it('accepts a plausible motorcycle movement', () => {
    const result = checkLocationJump(
      VICTORIA_ISLAND,
      start,
      LEKKI_PHASE_1,
      new Date(start.getTime() + 15 * 60_000),
      MAX_SPEED,
    );
    expect(result.acceptable).toBe(true);
    expect(result.impliedMetresPerSecond).toBeLessThan(MAX_SPEED);
  });

  it('rejects a teleport', () => {
    const result = checkLocationJump(
      IKEJA,
      start,
      VICTORIA_ISLAND,
      new Date(start.getTime() + 2000),
      MAX_SPEED,
    );
    expect(result.acceptable).toBe(false);
    expect(result.impliedMetresPerSecond).toBeGreaterThan(MAX_SPEED);
    // The implied speed is reported so the rejection can be explained in a log.
    expect(result.metres).toBeGreaterThan(19_000);
  });

  it('accepts a near-stationary point with a duplicate timestamp', () => {
    const nudged = { latitude: IKEJA.latitude + 0.0001, longitude: IKEJA.longitude };
    expect(checkLocationJump(IKEJA, start, nudged, start, MAX_SPEED).acceptable).toBe(true);
  });

  it('rejects a large jump with an out-of-order timestamp', () => {
    const result = checkLocationJump(
      IKEJA,
      start,
      VICTORIA_ISLAND,
      new Date(start.getTime() - 5000),
      MAX_SPEED,
    );
    expect(result.acceptable).toBe(false);
  });
});

describe('coarsen', () => {
  it('reduces precision for privacy', () => {
    const blurred = coarsen({ latitude: 6.428123456, longitude: 3.421987654 }, 4);
    expect(blurred).toEqual({ latitude: 6.4281, longitude: 3.422 });
  });

  it('keeps the point within ~11m of the original at 4dp', () => {
    const exact = { latitude: 6.428123456, longitude: 3.421987654 };
    expect(haversineMetres(exact, coarsen(exact, 4))).toBeLessThan(11);
  });
});
