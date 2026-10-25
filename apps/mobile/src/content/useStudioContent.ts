import { useEffect, useState } from 'react';
import type { PublicContentItem } from '@dash/domain/content';
import { loadStudioFeed } from '@dash/domain/content/presentation';
import { apiBaseUrl } from '../api';

/** Customer presentation only; deliberately bypasses session refresh/auth. */
export function useStudioContent(): PublicContentItem[] {
  const [items, setItems] = useState<PublicContentItem[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void loadStudioFeed(apiBaseUrl, fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setItems(result);
    });
    return () => controller.abort();
  }, []);
  return items;
}
