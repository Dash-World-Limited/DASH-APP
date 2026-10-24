import type { Metadata } from 'next';

import { SITE_ORIGIN } from '@/lib/declutter';
import { SellerVerificationPage } from './seller-verification';

export const metadata: Metadata = {
  title: 'Verify your seller profile — DASH Declutters',
  description: 'Verify your identity once before your DASH Declutters listings can go live.',
  alternates: { canonical: `${SITE_ORIGIN}/declutter/seller/verify` },
  robots: { index: false, follow: false },
};

export default function Page() {
  return <SellerVerificationPage />;
}
