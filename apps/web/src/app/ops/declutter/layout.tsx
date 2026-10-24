import Link from 'next/link';
import {
  DeclutterThemeShell,
  DeclutterThemeToggle,
} from '@/components/declutter/DeclutterTheme';

export default function DeclutterOpsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DeclutterThemeShell>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--surface-raised)] px-5 py-2">
        <Link href="/ops/declutter" className="text-sm font-bold">
          DASH Declutters · Ops
        </Link>
        <DeclutterThemeToggle />
      </div>
      {children}
    </DeclutterThemeShell>
  );
}
