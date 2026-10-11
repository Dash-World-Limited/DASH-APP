export interface HubPhoto {
  id: string;
  url: string;
  role: string;
  caption?: string | null;
}
export interface HubAction {
  label: string;
  cta: string;
  href: string;
}
export interface HubItem {
  id: string;
  code: string;
  title: string | null;
  description: string | null;
  condition: string | null;
  category: string | null;
  location: string | null;
  createdAt: string;
  status: string;
  valueCheckStatus: string;
  expectedPriceKobo: number | null;
  authorizedPriceKobo: number | null;
  priceAcceptanceValid: boolean;
  preConsented: boolean;
  seller: { name: string; kycStatus: string };
  listing: {
    slug: string;
    priceKobo: number;
    publishedAt: string | null;
    availability: string;
  } | null;
  progress: { key: string; label: string; at: string | null; state: string }[];
  history: { label: string; at: string }[];
  unreadCount: number;
  conversationId: string | null;
  actions: HubAction[];
  blockers: string[];
  next: string;
  photos: HubPhoto[];
  updates: {
    id: string;
    status: string;
    title: string;
    description: string;
    condition: string;
    sellerMessage: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
    photos: HubPhoto[];
  }[];
}
export interface HubSummary {
  seller: { kycStatus: string; canSubmit: boolean } | null;
  items: HubItem[];
  unreadCount: number;
  totals: {
    total: number;
    underReview: number;
    actionRequired: number;
    approved: number;
    live: number;
  };
}
export const hubButton =
  'dcl-hub-button inline-flex min-h-12 items-center justify-center rounded-full border border-[var(--line-strong)] px-5 py-3 text-sm font-bold disabled:opacity-50';
export const hubCard =
  'dcl-hub-card dcl-glass min-w-0 rounded-[var(--radius-card)] border border-[var(--line)] p-5 sm:p-6';
export const hubInput =
  'min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm';
export const hubMoney = (value: number | null) =>
  value == null
    ? 'Not set'
    : new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: 'NGN',
        maximumFractionDigits: 2,
      }).format(value / 100);
export const hubDate = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-NG', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'Not yet';
