import type { Metadata } from 'next';
import { DeclutterAccount } from './account';

export const metadata: Metadata = {
  title: 'Your account — DASH Declutters',
  description: 'Your seller status and items on DASH Declutters.',
  robots: { index: false, follow: false },
};

export default function Page() { return <DeclutterAccount />; }
