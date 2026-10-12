'use client';
import { useHub } from './use-hub';
export function HubUnreadBadge({ staff = false }: { staff?: boolean }) {
  const { data } = useHub<{ unreadCount: number }>(
    `${staff ? '/v1/admin/declutter' : '/v1/declutter'}/unread-count`,
  );
  return data?.unreadCount ? (
    <span
      className="ml-2 rounded-full bg-[var(--primary)] px-2 py-1 text-xs text-[var(--on-primary)]"
      aria-label={`${data.unreadCount} unread messages`}
    >
      {data.unreadCount}
    </span>
  ) : null;
}
