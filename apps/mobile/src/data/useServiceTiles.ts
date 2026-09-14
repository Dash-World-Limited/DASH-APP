/**
 * The Home grid's services: the bundled contract immediately, the server's
 * copy as soon as it answers.
 *
 * Painting from the bundled copy first means Home is never a skeleton for the
 * six most important taps in the app, and never empty offline. The server's
 * answer then wins, so a service the operations team hides server-side
 * disappears from the grid without a release.
 */

import { useEffect, useState } from 'react';

import { api } from '../api';
import { BUNDLED_SERVICE_TILES, tilesFromServer, type ServiceTileModel } from './services';

export function useServiceTiles(): readonly ServiceTileModel[] {
  const [tiles, setTiles] = useState<readonly ServiceTileModel[]>(BUNDLED_SERVICE_TILES);

  useEffect(() => {
    if (!api.configured) return;
    let cancelled = false;
    api
      .request<unknown>('/v1/service-categories', { auth: false })
      .then((body) => {
        // An empty, malformed or collapsed answer is a server problem, not a
        // reason to take the doors off Home (see MIN_SERVER_SERVICES).
        const fromServer = tilesFromServer(body);
        if (!cancelled && fromServer) setTiles(fromServer);
      })
      .catch(() => {
        // Keep the bundled contract. Offline Home still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return tiles;
}
