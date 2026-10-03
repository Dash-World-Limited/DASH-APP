'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';

interface LiveRider {
  id: string;
  name: string | null;
  availability: string;
  vehicleType: string;
  vehiclePlate: string | null;
  latitude: number | null;
  longitude: number | null;
  locationAgeSeconds: number | null;
}

interface LiveOrder {
  id: string;
  code: string;
  status: string;
  vendor: string;
  zone: string | null;
  ageMinutes: number;
  alerts: string[];
  rider: {
    id: string;
    name: string | null;
    latitude: number | null;
    longitude: number | null;
    locationAgeSeconds: number | null;
  } | null;
  pickup: { latitude: number; longitude: number };
}

interface LivePayload {
  riders: LiveRider[];
  orders: LiveOrder[];
}

interface MapPoint {
  key: string;
  kind: 'rider' | 'pickup';
  latitude: number;
  longitude: number;
  label: string;
  detail: string;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 16;
const DEFAULT_CENTER = { latitude: 9.082, longitude: 8.6753 };

function project(latitude: number, longitude: number, zoom: number) {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sin = Math.sin((lat * Math.PI) / 180);
  const scale = TILE_SIZE * 2 ** zoom;
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function zoomToFit(points: readonly MapPoint[], width: number, height: number): number {
  if (points.length <= 1) return 14;
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom -= 1) {
    const projected = points.map((point) => project(point.latitude, point.longitude, zoom));
    const xs = projected.map((point) => point.x);
    const ys = projected.map((point) => point.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX <= width * 0.68 && spanY <= height * 0.68) return zoom;
  }
  return MIN_ZOOM;
}

function LiveMap({ points }: { points: readonly MapPoint[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const height = 520;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(320, node.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const basis = points.length > 0
      ? points
      : [{
          key: 'default',
          kind: 'pickup' as const,
          latitude: DEFAULT_CENTER.latitude,
          longitude: DEFAULT_CENTER.longitude,
          label: 'DASH',
          detail: '',
        }];
    const zoom = points.length > 0 ? zoomToFit(basis, width, height) : 5;
    const projected = basis.map((point) => ({ point, ...project(point.latitude, point.longitude, zoom) }));
    const minX = Math.min(...projected.map((point) => point.x));
    const maxX = Math.max(...projected.map((point) => point.x));
    const minY = Math.min(...projected.map((point) => point.y));
    const maxY = Math.max(...projected.map((point) => point.y));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const leftWorld = centerX - width / 2;
    const topWorld = centerY - height / 2;
    const tileCount = 2 ** zoom;
    const minTileX = Math.floor(leftWorld / TILE_SIZE) - 1;
    const maxTileX = Math.floor((leftWorld + width) / TILE_SIZE) + 1;
    const minTileY = Math.max(0, Math.floor(topWorld / TILE_SIZE) - 1);
    const maxTileY = Math.min(tileCount - 1, Math.floor((topWorld + height) / TILE_SIZE) + 1);
    const tiles: { key: string; url: string; left: number; top: number }[] = [];

    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
        tiles.push({
          key: `${zoom}-${tileX}-${tileY}`,
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
          left: tileX * TILE_SIZE - leftWorld,
          top: tileY * TILE_SIZE - topWorld,
        });
      }
    }

    return {
      zoom,
      tiles,
      markers: points.map((point) => {
        const pixel = project(point.latitude, point.longitude, zoom);
        return { ...point, left: pixel.x - leftWorld, top: pixel.y - topWorld };
      }),
    };
  }, [height, points, width]);

  return (
    <div
      ref={ref}
      className="relative h-[520px] overflow-hidden rounded-3xl border border-[var(--line)] bg-[#d8ddd5]"
      aria-label="Live DASH operations map"
    >
      {geometry.tiles.map((tile) => (
        <div
          key={tile.key}
          className="absolute h-64 w-64 bg-cover bg-center"
          style={{
            left: tile.left,
            top: tile.top,
            backgroundImage: `url("${tile.url}")`,
          }}
          aria-hidden="true"
        />
      ))}

      {geometry.markers.map((marker) => (
        <div
          key={marker.key}
          className="group absolute z-10 -translate-x-1/2 -translate-y-1/2"
          style={{ left: marker.left, top: marker.top }}
        >
          <div
            className={
              'flex h-9 min-w-9 items-center justify-center rounded-full border-[3px] border-white px-2 text-[11px] font-black shadow-lg ' +
              (marker.kind === 'rider'
                ? 'bg-[var(--ink)] text-[var(--ink-inverted)]'
                : 'bg-[var(--primary)] text-[var(--on-primary)]')
            }
          >
            {marker.kind === 'rider' ? 'R' : 'P'}
          </div>
          <div className="pointer-events-none absolute left-1/2 top-11 hidden w-56 -translate-x-1/2 rounded-xl bg-[var(--ink)] px-3 py-2 text-xs text-[var(--ink-inverted)] shadow-xl group-hover:block">
            <p className="font-extrabold">{marker.label}</p>
            <p className="mt-1 opacity-70">{marker.detail}</p>
          </div>
        </div>
      ))}

      <div className="absolute left-4 top-4 z-20 flex gap-2 rounded-xl bg-[var(--surface-raised)]/95 px-3 py-2 text-[11px] font-bold shadow">
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-[var(--ink)]" />Rider</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-[var(--primary)]" />Pickup</span>
      </div>

      {points.length === 0 ? (
        <div className="absolute inset-x-4 bottom-12 z-20 mx-auto max-w-md rounded-2xl bg-[var(--surface-raised)]/95 p-4 text-center shadow-lg">
          <p className="text-sm font-extrabold">No live positions yet</p>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
            Approved riders appear here after they go online and report a current location. Active order pickups appear automatically.
          </p>
        </div>
      ) : null}

      <div className="absolute bottom-1.5 right-2 z-20 rounded bg-white/85 px-1.5 py-0.5 text-[9px] text-black/70">
        © OpenStreetMap contributors · zoom {geometry.zoom}
      </div>
    </div>
  );
}

function ageLabel(seconds: number | null): string {
  if (seconds === null) return 'No location time';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export default function AdminLivePage() {
  const signedIn = useHasSession();
  const { permissions, loaded } = usePermissions();
  const canRead = permissions.has('ops:livemap:read');
  const [payload, setPayload] = useState<LivePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!signedIn || !loaded || !canRead) return;
    try {
      const next = await authedFetch<LivePayload>('/v1/ops/live');
      setPayload(next);
      setRefreshedAt(new Date());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not load the live operations map.');
    }
  }, [canRead, loaded, signedIn]);

  useEffect(() => {
    void load();
    if (!signedIn || !loaded || !canRead) return;
    const timer = window.setInterval(() => void load(), 7_000);
    return () => window.clearInterval(timer);
  }, [canRead, load, loaded, signedIn]);

  const points = useMemo<MapPoint[]>(() => {
    if (!payload) return [];
    const next: MapPoint[] = [];

    for (const rider of payload.riders ?? []) {
      if (rider.latitude === null || rider.longitude === null) continue;
      next.push({
        key: `rider-${rider.id}`,
        kind: 'rider',
        latitude: rider.latitude,
        longitude: rider.longitude,
        label: rider.name ?? 'DASH rider',
        detail: `${rider.availability.replace(/_/g, ' ')} · ${rider.vehicleType.replace(/_/g, ' ')} · ${ageLabel(rider.locationAgeSeconds)}`,
      });
    }

    for (const order of payload.orders ?? []) {
      next.push({
        key: `pickup-${order.id}`,
        kind: 'pickup',
        latitude: order.pickup.latitude,
        longitude: order.pickup.longitude,
        label: order.vendor,
        detail: `${order.code} · ${order.status.replace(/_/g, ' ')}`,
      });

      if (
        order.rider &&
        order.rider.latitude !== null &&
        order.rider.longitude !== null &&
        !next.some((point) => point.key === `rider-${order.rider?.id}`)
      ) {
        next.push({
          key: `rider-${order.rider.id}`,
          kind: 'rider',
          latitude: order.rider.latitude,
          longitude: order.rider.longitude,
          label: order.rider.name ?? 'Assigned rider',
          detail: `${order.code} · ${ageLabel(order.rider.locationAgeSeconds)}`,
        });
      }
    }

    return next;
  }, [payload]);

  if (!signedIn && loaded) {
    return (
      <section className="mx-auto max-w-3xl px-5 py-16">
        <div className="admin-card rounded-3xl p-8 text-center">
          <h1 className="text-2xl font-extrabold">Super Admin sign-in required</h1>
          <Link href="/admin/signin" className="mt-5 inline-flex rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-extrabold text-[var(--on-primary)]">
            Sign in
          </Link>
        </div>
      </section>
    );
  }

  if (loaded && !canRead) {
    return (
      <section className="mx-auto max-w-3xl px-5 py-16">
        <div className="admin-card rounded-3xl p-8 text-center">
          <h1 className="text-2xl font-extrabold">Live map access is not enabled</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">This administrator does not have the live-operations permission.</p>
        </div>
      </section>
    );
  }

  const riders = payload?.riders ?? [];
  const orders = payload?.orders ?? [];

  return (
    <div className="min-h-[calc(100vh-4.5rem)] px-4 py-6 sm:px-6 sm:py-8 xl:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="admin-kicker">Live operations</p>
            <h1 className="mt-1 text-3xl font-extrabold tracking-[-0.03em]">Riders & active pickups</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-muted)]">
              Approved riders appear when they are online and reporting location. The board refreshes every seven seconds.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {refreshedAt ? <span className="text-xs text-[var(--ink-muted)]">Updated {refreshedAt.toLocaleTimeString()}</span> : null}
            <button type="button" onClick={() => void load()} className="rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-4 py-2.5 text-xs font-extrabold">
              Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div role="alert" className="mt-5 rounded-2xl border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-5 py-4 text-sm font-semibold text-[var(--danger)]">
            {error}
          </div>
        ) : null}

        <section className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="admin-card rounded-2xl p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Online riders</p>
            <p className="mt-2 text-3xl font-extrabold">{payload ? riders.length : '—'}</p>
          </div>
          <div className="admin-card rounded-2xl p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Active orders</p>
            <p className="mt-2 text-3xl font-extrabold">{payload ? orders.length : '—'}</p>
          </div>
          <div className="admin-card rounded-2xl p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Alerts</p>
            <p className="mt-2 text-3xl font-extrabold">{payload ? orders.filter((order) => order.alerts.length > 0).length : '—'}</p>
          </div>
        </section>

        <section className="mt-6">
          <LiveMap points={points} />
        </section>

        <section className="mt-6 grid gap-5 xl:grid-cols-2">
          <div className="admin-card rounded-3xl p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div><p className="admin-kicker">Riders</p><h2 className="mt-1 text-xl font-extrabold">Currently online</h2></div>
              <Link href="/admin/partners?tab=riders" className="text-xs font-extrabold text-[var(--primary)]">Rider approvals →</Link>
            </div>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {payload === null ? <p className="py-4 text-sm text-[var(--ink-muted)]">Loading riders…</p> : null}
              {payload && riders.length === 0 ? <p className="py-4 text-sm text-[var(--ink-muted)]">No approved rider is online right now.</p> : null}
              {riders.slice(0, 12).map((rider) => (
                <div key={rider.id} className="flex items-center gap-3 py-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--ink)] text-xs font-extrabold text-[var(--ink-inverted)]">
                    {(rider.name ?? 'R').slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-extrabold">{rider.name ?? 'DASH rider'}</p>
                    <p className="mt-0.5 text-xs capitalize text-[var(--ink-muted)]">{rider.vehicleType.replace(/_/g, ' ')} · {rider.availability.replace(/_/g, ' ')}</p>
                  </div>
                  <span className="text-xs text-[var(--ink-muted)]">{ageLabel(rider.locationAgeSeconds)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="admin-card rounded-3xl p-5 sm:p-6">
            <p className="admin-kicker">Dispatch</p>
            <h2 className="mt-1 text-xl font-extrabold">Active orders</h2>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {payload === null ? <p className="py-4 text-sm text-[var(--ink-muted)]">Loading orders…</p> : null}
              {payload && orders.length === 0 ? <p className="py-4 text-sm text-[var(--ink-muted)]">Nothing is in flight right now.</p> : null}
              {orders.slice(0, 12).map((order) => (
                <div key={order.id} className="flex items-start gap-3 py-3">
                  <div className={'mt-1 h-2.5 w-2.5 shrink-0 rounded-full ' + (order.alerts.length ? 'bg-[var(--danger)]' : 'bg-[var(--success)]')} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-extrabold">{order.code}</p>
                    <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{order.vendor}{order.zone ? ` · ${order.zone}` : ''}</p>
                  </div>
                  <span className="text-xs capitalize text-[var(--ink-muted)]">{order.status.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
