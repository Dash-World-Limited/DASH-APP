'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSessionState } from '@/lib/session';
import { HubUnreadBadge } from './HubUnreadBadge';

export function SellerMobileNav() {
  const pathname = usePathname();
  const session = useSessionState();
  if (session !== 'authenticated' || !pathname.startsWith('/declutter/account'))
    return null;
  return (
    <nav aria-label="Seller hub" className="dcl-mobile-nav md:hidden">
      <Link
        href="/declutter/account"
        aria-current={pathname === '/declutter/account' ? 'page' : undefined}
      >
        <svg
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="7" height="7" rx="2" />
          <rect x="14" y="3" width="7" height="7" rx="2" />
          <rect x="3" y="14" width="7" height="7" rx="2" />
          <rect x="14" y="14" width="7" height="7" rx="2" />
        </svg>
        My items
      </Link>
      <Link href="/declutter/sell">
        <svg
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v10M7 12h10" />
        </svg>
        Sell an item
      </Link>
      <Link
        href="/declutter/account/messages"
        aria-current={pathname.endsWith('/messages') ? 'page' : undefined}
      >
        <span className="relative">
          <svg
            width="21"
            height="21"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="M21 12a8 8 0 0 1-8 8H4l-1 1V4l1-1h9a8 8 0 0 1 8 9Z" />
            <path d="M7 8h10M7 12h7" />
          </svg>
          <span className="absolute -right-3 -top-2">
            <HubUnreadBadge />
          </span>
        </span>
        Messages
      </Link>
    </nav>
  );
}
