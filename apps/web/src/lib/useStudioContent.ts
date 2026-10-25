'use client';
import { useEffect, useState } from 'react';
import type { PublicContentItem } from '@dash/domain/content';
import { loadStudioFeed } from '@dash/domain/content/presentation';
import { API_BASE } from './api';
export function useStudioContent(enabled = true): PublicContentItem[] {
  const [items, setItems] = useState<PublicContentItem[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadStudioFeed(API_BASE, fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setItems(result);
    });
    return () => controller.abort();
  }, [enabled]);
  return items;
}
