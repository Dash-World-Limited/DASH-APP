'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { DashWordmark } from '@/components/brand/DashWordmark';
import { signOut, useMe } from '@/lib/session';
import { AdminThemeToggle, useAdminTheme } from './AdminTheme';

const NAV = [
  { href: '/admin', label: 'Overview', icon: 'grid' },
  { href: '/admin/partners', label: 'Partners', icon: 'people' },
  { href: '/admin/live', label: 'Live map', icon: 'pulse' },
  { href: '/admin/orders', label: 'Orders', icon: 'box' },
] as const;

function NavIcon({ name }: { name: 'grid' | 'people' | 'pulse' | 'wallet' | 'box' }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'h-5 w-5',
    'aria-hidden': true,
  };
  if (name === 'grid') return <svg {...common}><rect x="4" y="4" width="6" height="6" rx="1.4"/><rect x="14" y="4" width="6" height="6" rx="1.4"/><rect x="4" y="14" width="6" height="6" rx="1.4"/><rect x="14" y="14" width="6" height="6" rx="1.4"/></svg>;
  if (name === 'people') return <svg {...common}><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M16 4.6a3.4 3.4 0 0 1 0 6.5M21 20v-1.5a4 4 0 0 0-3-3.7"/></svg>;
  if (name === 'pulse') return <svg {...common}><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>;
  if (name === 'wallet') return <svg {...common}><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v16H6.5A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 7h15M15 11h6v5h-6a2.5 2.5 0 0 1 0-5Z"/></svg>;
  return <svg {...common}><path d="m4 8 8-4 8 4-8 4z"/><path d="m4 8v8l8 4 8-4V8M12 12v8"/></svg>;
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, loaded } = useMe();
  const { theme, setTheme } = useAdminTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  // The sign-in screen uses the same palette but deliberately no privileged
  // navigation chrome: no dashboard information is mounted before auth.
  if (pathname === '/admin/signin') {
    return (
      <div data-surface="admin" data-admin-theme={theme} className="min-h-screen bg-[var(--surface)] text-[var(--ink)]">
        {children}
      </div>
    );
  }

  // UI gate only; every API action still authorises independently. Keeping a
  // customer or ordinary staff session out of this shell avoids presenting
  // controls they can never use and makes "Super Admin" mean exactly that.
  if (loaded && me && !me.roles.includes('super_admin')) {
    return (
      <div data-surface="admin" data-admin-theme={theme} className="min-h-screen bg-[var(--surface)] px-5 py-16 text-[var(--ink)]">
        <div className="admin-card mx-auto max-w-xl rounded-3xl p-8 text-center">
          <DashWordmark height="1.2rem" />
          <p className="admin-kicker mt-8">Restricted</p>
          <h1 className="mt-2 text-2xl font-extrabold">Super Admin access only</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
            This signed-in account does not hold the Super Admin role.
          </p>
          <button
            type="button"
            onClick={() => void signOut().then(() => router.replace('/admin/signin'))}
            className="mt-6 min-h-11 rounded-xl bg-[var(--primary)] px-5 text-sm font-extrabold text-[var(--on-primary)]"
          >
            Use another account
          </button>
        </div>
      </div>
    );
  }

  const name = me?.identity.displayName ?? me?.identity.email ?? 'DASH administrator';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'DA';

  const nav = (
    <div className="flex h-full flex-col">
      <div className="flex h-20 items-center px-6 text-[var(--admin-sidebar-ink)]">
        <DashWordmark height="1.15rem" />
        <span className="ml-3 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--admin-sidebar-muted)]">
          Super Admin
        </span>
      </div>

      <nav className="mt-3 space-y-1 px-3" aria-label="Super Admin">
        {NAV.map((item) => {
          const active = item.href === '/admin'
            ? pathname === '/admin'
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={
                'flex min-h-12 items-center gap-3 rounded-xl px-3.5 text-sm font-semibold transition ' +
                (active
                  ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                  : 'text-[var(--admin-sidebar-muted)] hover:bg-white/[0.06] hover:text-[var(--admin-sidebar-ink)]')
              }
            >
              <NavIcon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-white/10 p-4">
        <div className="mb-3 rounded-xl bg-white/[0.045] p-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-sm font-extrabold text-[var(--on-primary)]">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-[var(--admin-sidebar-ink)]">{name}</p>
              <p className="mt-0.5 text-[11px] text-[var(--admin-sidebar-muted)]">Privileged session</p>
            </div>
          </div>
        </div>
        <p className="text-[10px] leading-4 text-[var(--admin-sidebar-muted)]">
          Sensitive actions are audited and may require MFA step-up.
        </p>
        <button
          type="button"
          onClick={() => void signOut().then(() => router.replace('/admin/signin'))}
          className="mt-3 w-full rounded-xl border border-white/10 px-3 py-2.5 text-left text-xs font-bold text-[var(--admin-sidebar-muted)] transition hover:bg-white/[0.05] hover:text-[var(--admin-sidebar-ink)]"
        >
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div data-surface="admin" data-admin-theme={theme} className="min-h-screen bg-[var(--surface)] text-[var(--ink)]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 bg-[var(--admin-sidebar)] lg:block">
        {nav}
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button className="absolute inset-0 bg-black/55" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <aside className="relative h-full w-[82vw] max-w-72 bg-[var(--admin-sidebar)] shadow-2xl">{nav}</aside>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--surface)]/90 backdrop-blur-xl">
          <div className="flex h-18 items-center gap-3 px-4 sm:px-6 xl:px-8">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] lg:hidden"
              aria-label="Open navigation"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
            </button>

            <div className="lg:hidden"><DashWordmark height="1rem" /></div>

            <div className="ml-auto flex items-center gap-3">
              <div className="hidden w-44 sm:block">
                <AdminThemeToggle theme={theme} onChange={setTheme} />
              </div>
              <div className="hidden h-9 w-px bg-[var(--line)] sm:block" />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--ink)] text-xs font-extrabold text-[var(--ink-inverted)]">
                {initials}
              </div>
            </div>
          </div>
          <div className="border-t border-[var(--line)] px-4 py-2 sm:hidden">
            <AdminThemeToggle theme={theme} onChange={setTheme} />
          </div>
        </header>

        <main id="main">{children}</main>
      </div>
    </div>
  );
}
