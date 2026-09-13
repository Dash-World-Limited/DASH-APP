/**
 * Whether the rider is Online — the one switch a rider's whole shift hangs on.
 *
 * STAGING: held on the device only. This build does not tell dispatch the
 * rider is available, report a position, or hold an online lease, so nothing
 * here can cause a real offer to be sent or withheld. The screens say so.
 *
 * Wired, going Online is POST /v1/rider/availability followed by location
 * reports, and every rule that decides whether an offer may reach this rider —
 * approval, lease, capacity, zone, distance, and a position no older than 120
 * seconds at acceptance — stays on the server. The app reflects that state; it
 * never decides it. Going Offline must always be one tap away, and must stop
 * location reporting, because there is no hidden tracking of a rider who has
 * said they are off.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface RiderShiftValue {
  online: boolean;
  setOnline: (next: boolean) => void;
}

const RiderShiftContext = createContext<RiderShiftValue | null>(null);

export function RiderShiftProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(false);
  const value = useMemo(() => ({ online, setOnline }), [online]);
  return <RiderShiftContext.Provider value={value}>{children}</RiderShiftContext.Provider>;
}

export function useRiderShift(): RiderShiftValue {
  const value = useContext(RiderShiftContext);
  if (!value) throw new Error('useRiderShift must be used inside <RiderShiftProvider>.');
  return value;
}
