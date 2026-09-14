'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ApiRequestError } from '@/lib/api';
import { PickupDialog, RejectDialog } from '@/components/vendor-dialogs';
import {
  authedFetch,
  useMe,
  usePermissions,
  useSessionState,
} from '@/lib/session';
import { liveLabel, useLive } from '@/lib/useLive';
import styles from './vendor.module.css';
import { DashWordmark as BrandWordmark } from '@/components/brand/DashWordmark';

type Section =
  | 'home'
  | 'orders'
  | 'catalog'
  | 'inventory'
  | 'analytics'
  | 'promotions'
  | 'reviews'
  | 'profile';
type OrderTab = 'incoming' | 'active' | 'completed';
type BranchState = 'open' | 'busy' | 'closed';
type IconName =
  | 'home'
  | 'orders'
  | 'catalog'
  | 'inventory'
  | 'analytics'
  | 'promotion'
  | 'review'
  | 'profile'
  | 'bell'
  | 'plus'
  | 'refresh'
  | 'store'
  | 'clock'
  | 'arrow'
  | 'close'
  | 'edit'
  | 'search'
  | 'image';

interface VendorOrder {
  id: string;
  code: string;
  status: string;
  mode: string;
  itemsSubtotal: number;
  total: number;
  createdAt: string;
  placedAt: string | null;
  estimatedReadyAt: string | null;
  instructions: string | null;
  items: {
    nameSnapshot: string;
    priceSnapshot: number;
    quantity: number;
    lineTotal: number;
    modifiers: unknown;
    instructions: string | null;
  }[];
  customer: { name: string };
  rider: { name: string | null } | null;
}

interface Branch {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  state: BranchState;
  busyExtraMinutes: number;
  minimumOrder: number;
  defaultPrepMinutes: number;
  supportsDelivery: boolean;
  supportsPickup: boolean;
  supportsVendorDelivery: boolean;
}

interface Stock {
  branchId: string;
  quantity: number | null;
  isAvailable: boolean;
  updatedAt: string;
}

interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  imageKey: string | null;
  price: number;
  prepMinutes: number;
  isAvailable: boolean;
  requiresAgeCheck: boolean;
  updatedAt: string;
  stock: Stock[];
}

interface Category {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  items: CatalogItem[];
}

interface Review {
  id: string;
  rating: number;
  comment: string | null;
  vendorResponse: string | null;
  respondedAt: string | null;
  createdAt: string;
  orderCode: string;
  customerName: string;
}

interface DashboardResponse {
  vendor: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    category: string;
    status: string;
    logoKey: string | null;
    coverKey: string | null;
    ratingAverage: number;
    ratingCount: number;
    autoAcceptSeconds: number;
    branches: Branch[];
    categories: Category[];
    reviews: Review[];
  };
}

interface ReportResponse {
  periodDays: number;
  orders: {
    delivered: number;
    rejected: number;
    cancelled: number;
    total: number;
  };
  itemsRevenue: number;
  rejectionRate: number;
}

interface PayoutResponse {
  payoutDetails: {
    configured: boolean;
    bankName: string | null;
    accountNumberMasked: string | null;
    updatedAt: string | null;
  };
}

interface ProductDraft {
  categoryId: string;
  name: string;
  description: string;
  priceNaira: string;
  prepMinutes: string;
  quantity: string;
  requiresAgeCheck: boolean;
}

const NAV_ITEMS: readonly { id: Section; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'orders', label: 'Orders', icon: 'orders' },
  { id: 'catalog', label: 'Catalog', icon: 'catalog' },
  { id: 'inventory', label: 'Inventory', icon: 'inventory' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  { id: 'promotions', label: 'Promotions', icon: 'promotion' },
  { id: 'reviews', label: 'Reviews & Support', icon: 'review' },
  { id: 'profile', label: 'Profile & Settings', icon: 'profile' },
] as const;

const SECTION_COPY: Record<Section, { eyebrow: string; title: string; subtitle: string }> = {
  home: {
    eyebrow: 'Vendor workspace',
    title: 'Good day',
    subtitle: 'Here is what is happening with your business.',
  },
  orders: {
    eyebrow: 'Live operations',
    title: 'Orders',
    subtitle: 'Accept, prepare and hand every order to the correct rider.',
  },
  catalog: {
    eyebrow: 'Your storefront',
    title: 'Catalog',
    subtitle: 'Products customers can discover and order.',
  },
  inventory: {
    eyebrow: 'Availability',
    title: 'Inventory',
    subtitle: 'Keep stock accurate so customers never order what is unavailable.',
  },
  analytics: {
    eyebrow: 'Performance',
    title: 'Analytics',
    subtitle: 'Revenue and fulfilment signals from completed orders.',
  },
  promotions: {
    eyebrow: 'Growth',
    title: 'Promotions',
    subtitle: 'Plan offers without turning discounts into accounting surprises.',
  },
  reviews: {
    eyebrow: 'Reputation',
    title: 'Reviews & Support',
    subtitle: 'Read customer feedback, respond, and reach DASH support.',
  },
  profile: {
    eyebrow: 'Business account',
    title: 'Profile & Settings',
    subtitle: 'Your business identity, branches and settlement destination.',
  },
};

const EMPTY_BUCKETS: Record<OrderTab, VendorOrder[]> = {
  incoming: [],
  active: [],
  completed: [],
};

function formatNaira(kobo: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(kobo / 100);
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('en-NG', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function directImageUrl(value: string | null): string | null {
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiRequestError ? caught.message : fallback;
}

/** The measured DASH wordmark (never typed); its size and colour come from the class. */
function DashWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? styles.wordmarkCompact : styles.wordmark}>
      <BrandWordmark />
    </span>
  );
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  let paths: ReactNode;

  switch (name) {
    case 'home':
      paths = (
        <>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5.5 9.5V21h13V9.5M9.5 21v-7h5v7" />
        </>
      );
      break;
    case 'orders':
      paths = (
        <>
          <path d="M6 3h12v18H6z" />
          <path d="M9 8h6M9 12h6M9 16h4" />
        </>
      );
      break;
    case 'catalog':
      paths = (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M8 4v16M8 9h13" />
        </>
      );
      break;
    case 'inventory':
      paths = (
        <>
          <path d="m4 7 8-4 8 4-8 4z" />
          <path d="M4 7v10l8 4 8-4V7M12 11v10" />
        </>
      );
      break;
    case 'analytics':
      paths = <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />;
      break;
    case 'promotion':
      paths = (
        <>
          <path d="M4 13V5l14-2v14L4 15z" />
          <path d="M7 15v5h4l1-4M18 8h3M19 4l2-2M19 12l2 2" />
        </>
      );
      break;
    case 'review':
      paths = (
        <>
          <path d="M4 4h16v12H8l-4 4z" />
          <path d="m12 7 1 2 2 .3-1.5 1.5.4 2.2-1.9-1-1.9 1 .4-2.2L9 9.3 11 9z" />
        </>
      );
      break;
    case 'profile':
      paths = (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c.8-4 3.4-6 8-6s7.2 2 8 6" />
        </>
      );
      break;
    case 'bell':
      paths = (
        <>
          <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8" />
          <path d="M10 21h4" />
        </>
      );
      break;
    case 'plus':
      paths = <path d="M12 5v14M5 12h14" />;
      break;
    case 'refresh':
      paths = (
        <>
          <path d="M20 6v5h-5" />
          <path d="M18.5 16a8 8 0 1 1 .8-7.8L20 11" />
        </>
      );
      break;
    case 'store':
      paths = (
        <>
          <path d="M4 10v11h16V10M3 10l2-6h14l2 6" />
          <path d="M3 10a3 3 0 0 0 5 2 3 3 0 0 0 4 0 3 3 0 0 0 4 0 3 3 0 0 0 5-2M9 21v-6h6v6" />
        </>
      );
      break;
    case 'clock':
      paths = (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      );
      break;
    case 'arrow':
      paths = <path d="m9 5 7 7-7 7" />;
      break;
    case 'close':
      paths = <path d="m6 6 12 12M18 6 6 18" />;
      break;
    case 'edit':
      paths = (
        <>
          <path d="m4 20 4-1 11-11-3-3L5 16z" />
          <path d="m14 7 3 3" />
        </>
      );
      break;
    case 'search':
      paths = (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </>
      );
      break;
    case 'image':
      paths = (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8" cy="9" r="1.5" />
          <path d="m4 17 5-5 4 4 2-2 5 4" />
        </>
      );
      break;
  }

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      {...common}
    >
      {paths}
    </svg>
  );
}

function StatusPill({ value }: { value: string }) {
  const positive = ['open', 'delivered', 'ready', 'accepted', 'preparing'].includes(value);
  const warning = ['busy', 'placed', 'vendor_reviewing', 'rider_assigned'].includes(value);
  return (
    <span
      className={
        positive
          ? styles.statusPositive
          : warning
            ? styles.statusWarning
            : styles.statusNeutral
      }
    >
      <span className={styles.statusDot} />
      {titleCase(value)}
    </span>
  );
}

function LoadingScreen() {
  return (
    <main className={styles.loadingScreen}>
      <DashWordmark />
      <span className={styles.spinner} aria-label="Restoring vendor session" />
    </main>
  );
}

function SignInScreen() {
  return (
    <main className={styles.signInScreen}>
      <section className={styles.signInBrand}>
        <DashWordmark />
        <div>
          <p className={styles.kickerLight}>DASH for business</p>
          <h1>Run your storefront from one calm workspace.</h1>
          <p>
            Orders, products, stock, performance and settlements—built for the people
            fulfilling every DASH order.
          </p>
        </div>
        <div className={styles.signInProof}>
          <span>Live orders</span>
          <span>Scoped access</span>
          <span>Realtime updates</span>
        </div>
      </section>
      <section className={styles.signInPanel}>
        <div className={styles.signInCard}>
          <p className={styles.eyebrow}>Vendor portal</p>
          <h2>Welcome back</h2>
          <p>Use the vendor account approved for your DASH storefront.</p>
          <Link className={styles.primaryButton} href="/signin?next=/vendor">
            Sign in to Vendor
          </Link>
          <small>
            Customer and rider accounts cannot enter this workspace. Access is checked
            by the API on every request.
          </small>
        </div>
      </section>
    </main>
  );
}

function EmptyState({
  icon = 'store',
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyIcon}>
        <Icon name={icon} size={25} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  tone = 'default',
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'default' | 'bronze' | 'green';
}) {
  return (
    <article
      className={
        tone === 'bronze'
          ? styles.metricBronze
          : tone === 'green'
            ? styles.metricGreen
            : styles.metric
      }
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vendor-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <div>
            <h2 id="vendor-modal-title">{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className={styles.iconButton} type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ProductForm({
  categories,
  item,
  canWrite,
  onClose,
  onSaved,
}: {
  categories: Category[];
  item: CatalogItem | null;
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initialCategory = item
    ? categories.find((category) => category.items.some((candidate) => candidate.id === item.id))?.id
    : categories[0]?.id;
  const stock = item?.stock[0];
  const [draft, setDraft] = useState<ProductDraft>({
    categoryId: initialCategory ?? '',
    name: item?.name ?? '',
    description: item?.description ?? '',
    priceNaira: item ? String(item.price / 100) : '',
    prepMinutes: String(item?.prepMinutes ?? 15),
    quantity: stock?.quantity === null || stock?.quantity === undefined ? '' : String(stock.quantity),
    requiresAgeCheck: item?.requiresAgeCheck ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canWrite || !draft.categoryId) return;
    setSaving(true);
    setFailure(null);
    try {
      const payload = {
        categoryId: draft.categoryId,
        name: draft.name,
        description: draft.description.trim() || null,
        price: Math.round(Number(draft.priceNaira) * 100),
        prepMinutes: Number(draft.prepMinutes),
        requiresAgeCheck: draft.requiresAgeCheck,
        ...(item || draft.quantity.trim() === ''
          ? {}
          : { quantity: Number(draft.quantity) }),
      };
      await authedFetch(item ? '/v1/vendor/items/' + item.id : '/v1/vendor/items', {
        method: item ? 'PATCH' : 'POST',
        body: payload,
      });
      if (item && draft.quantity.trim() !== '') {
        await authedFetch('/v1/vendor/items/' + item.id + '/availability', {
          method: 'PATCH',
          body: {
            isAvailable: Number(draft.quantity) > 0,
            quantity: Number(draft.quantity),
          },
        });
      }
      await onSaved();
      onClose();
    } catch (caught) {
      setFailure(errorMessage(caught, 'The product could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={item ? 'Edit product' : 'Add product'}
      subtitle="Prices are entered in naira and stored safely as integer kobo."
      onClose={onClose}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label>
          <span>Catalog section</span>
          <select
            value={draft.categoryId}
            required
            onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
          >
            <option value="" disabled>Select a section</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Product name</span>
          <input
            value={draft.name}
            minLength={2}
            maxLength={120}
            required
            placeholder="e.g. Jollof rice & grilled chicken"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className={styles.fullField}>
          <span>Description</span>
          <textarea
            value={draft.description}
            maxLength={1000}
            rows={3}
            placeholder="What customers should know about this product"
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <label>
          <span>Price (₦)</span>
          <input
            value={draft.priceNaira}
            type="number"
            min="0"
            step="0.01"
            required
            placeholder="0"
            onChange={(event) => setDraft({ ...draft, priceNaira: event.target.value })}
          />
        </label>
        <label>
          <span>Preparation time</span>
          <div className={styles.inputSuffix}>
            <input
              value={draft.prepMinutes}
              type="number"
              min="0"
              max="360"
              required
              onChange={(event) => setDraft({ ...draft, prepMinutes: event.target.value })}
            />
            <b>min</b>
          </div>
        </label>
        <label>
          <span>Quantity</span>
          <input
            value={draft.quantity}
            type="number"
            min="0"
            max="100000"
            placeholder="Not tracked"
            onChange={(event) => setDraft({ ...draft, quantity: event.target.value })}
          />
        </label>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={draft.requiresAgeCheck}
            onChange={(event) => setDraft({ ...draft, requiresAgeCheck: event.target.checked })}
          />
          <span>Require age verification</span>
        </label>
        <div className={styles.uploadNotice}>
          <Icon name="image" />
          <div>
            <strong>Product photography</strong>
            <span>
              The storage upload connection is the next catalog task. Existing real
              product URLs render now; this form will not invent an image.
            </span>
          </div>
        </div>
        {failure ? <p className={styles.formError}>{failure}</p> : null}
        <footer className={styles.formActions}>
          <button className={styles.secondaryButton} type="button" onClick={onClose}>Cancel</button>
          <button className={styles.primaryButton} type="submit" disabled={saving || !canWrite}>
            {saving ? 'Saving…' : item ? 'Save changes' : 'Add product'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function CategoryForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setFailure(null);
    try {
      await authedFetch('/v1/vendor/categories', {
        method: 'POST',
        body: { name, description: description.trim() || null },
      });
      await onSaved();
      onClose();
    } catch (caught) {
      setFailure(errorMessage(caught, 'The catalog section could not be created.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New catalog section" subtitle="Group products the way customers shop." onClose={onClose}>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label>
          <span>Section name</span>
          <input
            value={name}
            minLength={2}
            maxLength={80}
            required
            placeholder="e.g. Main meals"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={styles.fullField}>
          <span>Description</span>
          <textarea
            value={description}
            maxLength={240}
            rows={3}
            placeholder="Optional"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {failure ? <p className={styles.formError}>{failure}</p> : null}
        <footer className={styles.formActions}>
          <button className={styles.secondaryButton} type="button" onClick={onClose}>Cancel</button>
          <button className={styles.primaryButton} type="submit" disabled={saving}>
            {saving ? 'Creating…' : 'Create section'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ReviewResponseForm({
  review,
  onClose,
  onSaved,
}: {
  review: Review;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [response, setResponse] = useState(review.vendorResponse ?? '');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setFailure(null);
    try {
      await authedFetch('/v1/vendor/reviews/' + review.id + '/respond', {
        method: 'POST',
        body: { response },
      });
      await onSaved();
      onClose();
    } catch (caught) {
      setFailure(errorMessage(caught, 'Your response could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={'Reply to ' + review.customerName} subtitle={review.orderCode} onClose={onClose}>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <blockquote className={styles.reviewQuote}>
          {review.comment ?? 'This customer left a rating without a written comment.'}
        </blockquote>
        <label className={styles.fullField}>
          <span>Your public response</span>
          <textarea
            value={response}
            minLength={2}
            maxLength={500}
            rows={5}
            required
            onChange={(event) => setResponse(event.target.value)}
          />
        </label>
        {failure ? <p className={styles.formError}>{failure}</p> : null}
        <footer className={styles.formActions}>
          <button className={styles.secondaryButton} type="button" onClick={onClose}>Cancel</button>
          <button className={styles.primaryButton} type="submit" disabled={saving}>
            {saving ? 'Posting…' : 'Post response'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export default function VendorConsolePage() {
  const session = useSessionState();
  const { me } = useMe();
  const { permissions } = usePermissions();
  const [section, setSection] = useState<Section>('home');
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [reportDays, setReportDays] = useState(7);
  const [orders, setOrders] = useState<Record<OrderTab, VendorOrder[]> | null>(null);
  const [orderTab, setOrderTab] = useState<OrderTab>('incoming');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<CatalogItem | 'new' | null>(null);
  const [categoryForm, setCategoryForm] = useState(false);
  const [reviewForm, setReviewForm] = useState<Review | null>(null);
  const [rejecting, setRejecting] = useState<VendorOrder | null>(null);
  const [verifying, setVerifying] = useState<VendorOrder | null>(null);
  const [payout, setPayout] = useState<PayoutResponse['payoutDetails'] | null>(null);

  const canCatalogWrite = permissions.has('vendor:catalog:write');
  const canHoursWrite = permissions.has('vendor:hours:write');
  const canInventoryWrite = permissions.has('vendor:inventory:write');
  const canReviewRespond = permissions.has('vendor:review:respond');
  const canReadPayout = permissions.has('vendor:settlement:read');

  const loadDashboard = useCallback(async (): Promise<void> => {
    if (session !== 'authenticated') return;
    try {
      const result = await authedFetch<DashboardResponse>('/v1/vendor/dashboard');
      setDashboard(result);
      setSelectedBranchId((current) => current ?? result.vendor.branches[0]?.id ?? null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'The vendor workspace could not be loaded.'));
    }
  }, [session]);

  const loadOrders = useCallback(async (): Promise<void> => {
    if (session !== 'authenticated') return;
    try {
      const tabs: OrderTab[] = ['incoming', 'active', 'completed'];
      const results = await Promise.all(
        tabs.map((tab) =>
          authedFetch<{ orders: VendorOrder[] }>('/v1/vendor/orders?status=' + tab),
        ),
      );
      setOrders({
        incoming: results[0]?.orders ?? [],
        active: results[1]?.orders ?? [],
        completed: results[2]?.orders ?? [],
      });
      setError(null);
    } catch (caught) {
      setOrders(EMPTY_BUCKETS);
      setError(errorMessage(caught, 'The live order queue could not be loaded.'));
    }
  }, [session]);

  const loadReport = useCallback(async (): Promise<void> => {
    if (session !== 'authenticated' || !permissions.has('vendor:report:read')) return;
    try {
      setReport(
        await authedFetch<ReportResponse>('/v1/vendor/reports/summary?days=' + reportDays),
      );
    } catch (caught) {
      setError(errorMessage(caught, 'Performance data could not be loaded.'));
    }
  }, [permissions, reportDays, session]);

  const loadPayout = useCallback(async (): Promise<void> => {
    if (session !== 'authenticated' || !canReadPayout) return;
    try {
      const result = await authedFetch<PayoutResponse>('/v1/vendor/payout-details');
      setPayout(result.payoutDetails);
    } catch (caught) {
      setError(errorMessage(caught, 'Settlement details could not be loaded.'));
    }
  }, [canReadPayout, session]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => {
    if (section === 'profile') void loadPayout();
  }, [loadPayout, section]);

  const { status: liveStatus, refreshing } = useLive({
    topics: me?.vendorId ? ['vendor:' + me.vendorId] : [],
    load: loadOrders,
    pollMs: 8_000,
    enabled: session === 'authenticated',
  });

  const vendor = dashboard?.vendor ?? null;
  const branches = vendor?.branches ?? [];
  const selectedBranch =
    branches.find((branch) => branch.id === selectedBranchId) ?? branches[0] ?? null;
  const allItems = useMemo(
    () =>
      (vendor?.categories ?? []).flatMap((category) =>
        category.items.map((item) => ({ ...item, categoryName: category.name })),
      ),
    [vendor],
  );
  const visibleItems = allItems.filter((item) => {
    const needle = query.trim().toLowerCase();
    return !needle || item.name.toLowerCase().includes(needle) || item.categoryName.toLowerCase().includes(needle);
  });
  const currentOrders = orders?.[orderTab] ?? [];
  const selectedOrder =
    Object.values(orders ?? EMPTY_BUCKETS)
      .flat()
      .find((order) => order.id === selectedOrderId) ??
    currentOrders[0] ??
    null;
  const incomingCount = orders?.incoming.length ?? 0;
  const activeCount = orders?.active.length ?? 0;
  const unavailableCount = allItems.filter((item) => !item.isAvailable).length;
  const copy = SECTION_COPY[section];

  const run = async (
    key: string,
    request: () => Promise<unknown>,
    refresh: () => Promise<void> = loadOrders,
  ): Promise<void> => {
    setBusyKey(key);
    setError(null);
    try {
      await request();
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught, 'That change did not go through.'));
    } finally {
      setBusyKey(null);
    }
  };

  const setBranchState = async (state: BranchState): Promise<void> => {
    if (!selectedBranch || !canHoursWrite) return;
    await run(
      'branch-' + selectedBranch.id,
      () =>
        authedFetch('/v1/vendor/branch/' + selectedBranch.id + '/state', {
          method: 'PATCH',
          body: { state, busyExtraMinutes: state === 'busy' ? 15 : 0 },
        }),
      loadDashboard,
    );
  };

  const setAvailability = async (item: CatalogItem, isAvailable: boolean): Promise<void> => {
    if (!canInventoryWrite) return;
    const branchStock = item.stock.find((stock) => stock.branchId === selectedBranch?.id);
    await run(
      'item-' + item.id,
      () =>
        authedFetch('/v1/vendor/items/' + item.id + '/availability', {
          method: 'PATCH',
          body: {
            isAvailable,
            ...(branchStock?.quantity === undefined ? {} : { quantity: branchStock.quantity }),
          },
        }),
      loadDashboard,
    );
  };

  const orderAction = async (
    order: VendorOrder,
    action: 'accept' | 'prepare' | 'ready',
  ): Promise<void> => {
    if (action === 'accept') {
      await run(order.id, () =>
        authedFetch('/v1/vendor/orders/' + order.id + '/accept', {
          method: 'POST',
          body: { prepMinutes: selectedBranch?.defaultPrepMinutes ?? 20 },
        }),
      );
      return;
    }
    await run(order.id, () =>
      authedFetch('/v1/vendor/orders/' + order.id + '/progress', {
        method: 'POST',
        body: { to: action === 'prepare' ? 'preparing' : 'ready' },
      }),
    );
  };

  if (session === 'restoring') return <LoadingScreen />;
  if (session === 'unauthenticated') return <SignInScreen />;

  if (me && !me.vendorId) {
    return (
      <main className={styles.noAccess}>
        <DashWordmark />
        <EmptyState
          icon="profile"
          title="This is not a vendor account"
          body="Sign in with the owner, manager or staff account attached to your DASH storefront."
          action={
            <Link className={styles.primaryButton} href="/signin?next=/vendor">
              Use another account
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <div className={styles.shell} data-surface="vendor">
      <aside className={styles.sidebar}>
        <div className={styles.sidebarBrand}>
          <DashWordmark />
          <span>Vendor</span>
        </div>
        <div className={styles.vendorMini}>
          <span className={styles.vendorAvatar}>{initials(vendor?.name ?? 'DASH Vendor')}</span>
          <div>
            <strong>{vendor?.name ?? 'Loading business…'}</strong>
            <small>
              <span className={selectedBranch?.state === 'open' ? styles.onlineDot : styles.offlineDot} />
              {selectedBranch ? titleCase(selectedBranch.state) : 'Loading'}
            </small>
          </div>
        </div>
        <nav className={styles.sidebarNav} aria-label="Vendor workspace">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? styles.navActive : styles.navItem}
              onClick={() => setSection(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === 'orders' && incomingCount > 0 ? (
                <b className={styles.navBadge}>{incomingCount}</b>
              ) : null}
            </button>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <small>DASH for business</small>
          <span>Secure vendor workspace</span>
        </div>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.mobileHeader}>
          <div>
            <DashWordmark compact />
            <small>Vendor</small>
          </div>
          <span className={styles.vendorAvatarSmall}>{initials(vendor?.name ?? 'DV')}</span>
        </header>

        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>{copy.eyebrow}</p>
            <h1>
              {section === 'home' ? copy.title + (me?.identity.displayName ? ', ' + me.identity.displayName.split(' ')[0] : '') : copy.title}
            </h1>
            <p>{copy.subtitle}</p>
          </div>
          <div className={styles.topbarActions}>
            {branches.length > 0 ? (
              <label className={styles.branchPicker}>
                <Icon name="store" size={18} />
                <select
                  value={selectedBranch?.id ?? ''}
                  aria-label="Current branch"
                  onChange={(event) => setSelectedBranchId(event.target.value)}
                >
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <button className={styles.iconButton} type="button" aria-label="Notifications">
              <Icon name="bell" />
              {incomingCount > 0 ? <span className={styles.notificationDot} /> : null}
            </button>
            <span className={styles.profileChip}>
              <span>{initials(me?.identity.displayName ?? vendor?.name ?? 'DV')}</span>
              <b>{me?.identity.displayName ?? 'Vendor account'}</b>
            </span>
          </div>
        </header>

        <main id="main" className={styles.content}>
          {error ? (
            <div className={styles.errorBanner} role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)}><Icon name="close" size={17} /></button>
            </div>
          ) : null}

          {!vendor ? (
            <div className={styles.pageLoading}>
              <span className={styles.spinner} />
              <p>Preparing your vendor workspace…</p>
            </div>
          ) : null}

          {vendor && section === 'home' ? (
            <div className={styles.pageStack}>
              <section className={styles.branchBand}>
                <div>
                  <span className={styles.branchIcon}><Icon name="store" /></span>
                  <div>
                    <small>Store status</small>
                    <strong>{selectedBranch?.name ?? vendor?.name}</strong>
                    <p>{selectedBranch?.address ?? 'No active branch is assigned.'}</p>
                  </div>
                </div>
                <div className={styles.stateControl} aria-label="Store availability">
                  {(['open', 'busy', 'closed'] as const).map((state) => (
                    <button
                      key={state}
                      type="button"
                      disabled={!canHoursWrite || busyKey?.startsWith('branch-')}
                      className={selectedBranch?.state === state ? styles.stateSelected : ''}
                      onClick={() => void setBranchState(state)}
                    >
                      {titleCase(state)}
                    </button>
                  ))}
                </div>
              </section>

              <section className={styles.metricsGrid}>
                <MetricCard
                  label={report ? report.periodDays + '-day sales' : 'Sales'}
                  value={report ? formatNaira(report.itemsRevenue) : '—'}
                  note="Product subtotal after delivery"
                  tone="bronze"
                />
                <MetricCard
                  label="Completed orders"
                  value={report ? String(report.orders.delivered) : '—'}
                  note={report ? 'Last ' + report.periodDays + ' days' : 'Loading report'}
                />
                <MetricCard
                  label="Live orders"
                  value={String(incomingCount + activeCount)}
                  note={incomingCount + ' waiting · ' + activeCount + ' active'}
                  tone={incomingCount > 0 ? 'green' : 'default'}
                />
                <MetricCard
                  label="Customer rating"
                  value={vendor.ratingCount > 0 ? vendor.ratingAverage.toFixed(1) : 'New'}
                  note={vendor.ratingCount + ' published reviews'}
                />
              </section>

              <section className={styles.homeGrid}>
                <article className={styles.panel}>
                  <header className={styles.panelHeader}>
                    <div>
                      <p className={styles.eyebrow}>Needs attention</p>
                      <h2>Incoming orders</h2>
                    </div>
                    <button
                      className={styles.textButton}
                      type="button"
                      onClick={() => {
                        setOrderTab('incoming');
                        setSection('orders');
                      }}
                    >
                      View all <Icon name="arrow" size={16} />
                    </button>
                  </header>
                  <p className={styles.liveLine}>
                    <span className={liveStatus === 'live' ? styles.liveDot : styles.pollDot} />
                    {liveLabel(liveStatus, 8_000)}
                    {refreshing ? ' · updating' : ''}
                  </p>
                  {(orders?.incoming ?? []).slice(0, 4).map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      className={styles.orderPreview}
                      onClick={() => {
                        setSelectedOrderId(order.id);
                        setOrderTab('incoming');
                        setSection('orders');
                      }}
                    >
                      <span className={styles.orderCode}>{order.code.replace('DASH-', '')}</span>
                      <span>
                        <strong>{order.customer.name}</strong>
                        <small>
                          {order.items.reduce((sum, item) => sum + item.quantity, 0)} items ·{' '}
                          {formatTime(order.placedAt ?? order.createdAt)}
                        </small>
                      </span>
                      <b>{formatNaira(order.itemsSubtotal)}</b>
                      <Icon name="arrow" size={17} />
                    </button>
                  ))}
                  {orders && orders.incoming.length === 0 ? (
                    <EmptyState
                      icon="orders"
                      title="No new orders"
                      body="The next paid order will appear here automatically."
                    />
                  ) : null}
                </article>

                <aside className={styles.quickPanel}>
                  <header className={styles.panelHeader}>
                    <div><p className={styles.eyebrow}>Shortcuts</p><h2>Quick actions</h2></div>
                  </header>
                  <button type="button" onClick={() => setSection('catalog')} disabled={!canCatalogWrite}>
                    <span><Icon name="plus" /></span>
                    <div><strong>Add a product</strong><small>Grow your storefront</small></div>
                    <Icon name="arrow" size={17} />
                  </button>
                  <button type="button" onClick={() => setSection('inventory')}>
                    <span><Icon name="inventory" /></span>
                    <div><strong>Update stock</strong><small>{unavailableCount} unavailable</small></div>
                    <Icon name="arrow" size={17} />
                  </button>
                  <button type="button" onClick={() => setSection('analytics')}>
                    <span><Icon name="analytics" /></span>
                    <div><strong>View performance</strong><small>Revenue and completion</small></div>
                    <Icon name="arrow" size={17} />
                  </button>
                </aside>
              </section>
            </div>
          ) : null}

          {vendor && section === 'orders' ? (
            <div className={styles.pageStack}>
              <section className={styles.toolbar}>
                <div className={styles.segmented}>
                  {(['incoming', 'active', 'completed'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={orderTab === tab ? styles.segmentSelected : ''}
                      onClick={() => {
                        setOrderTab(tab);
                        setSelectedOrderId(null);
                      }}
                    >
                      {titleCase(tab)}<span>{orders?.[tab].length ?? 0}</span>
                    </button>
                  ))}
                </div>
                <button className={styles.secondaryButton} type="button" onClick={() => void loadOrders()}>
                  <Icon name="refresh" size={17} />Refresh
                </button>
              </section>
              <section className={styles.orderWorkspace}>
                <div className={styles.orderList}>
                  <div className={styles.orderListHeader}>
                    <span>{titleCase(orderTab)} queue</span>
                    <small>{liveLabel(liveStatus, 8_000)}</small>
                  </div>
                  {currentOrders.map((order) => (
                    <button
                      type="button"
                      key={order.id}
                      className={selectedOrder?.id === order.id ? styles.orderRowSelected : styles.orderRow}
                      onClick={() => setSelectedOrderId(order.id)}
                    >
                      <div><strong>{order.code}</strong><small>{formatTime(order.placedAt ?? order.createdAt)}</small></div>
                      <span>{order.customer.name}</span>
                      <b>{formatNaira(order.itemsSubtotal)}</b>
                      <StatusPill value={order.status} />
                    </button>
                  ))}
                  {orders && currentOrders.length === 0 ? (
                    <EmptyState
                      icon="orders"
                      title={orderTab === 'incoming' ? 'No orders waiting' : 'No ' + orderTab + ' orders'}
                      body={orderTab === 'incoming' ? 'New orders appear here in realtime.' : 'Orders move here as fulfilment progresses.'}
                    />
                  ) : null}
                </div>
                <div className={styles.orderDetail}>
                  {selectedOrder ? (
                    <>
                      <header>
                        <div><p className={styles.eyebrow}>Order detail</p><h2>{selectedOrder.code}</h2></div>
                        <StatusPill value={selectedOrder.status} />
                      </header>
                      <div className={styles.orderMeta}>
                        <span><small>Customer</small><strong>{selectedOrder.customer.name}</strong></span>
                        <span><small>Placed</small><strong>{formatTime(selectedOrder.placedAt ?? selectedOrder.createdAt)}</strong></span>
                        <span><small>Method</small><strong>{titleCase(selectedOrder.mode)}</strong></span>
                        <span><small>Ready by</small><strong>{formatTime(selectedOrder.estimatedReadyAt)}</strong></span>
                      </div>
                      <div className={styles.orderItems}>
                        <h3>Items</h3>
                        {selectedOrder.items.map((item, index) => (
                          <div key={item.nameSnapshot + String(index)}>
                            <span className={styles.quantity}>{item.quantity}</span>
                            <span>
                              <strong>{item.nameSnapshot}</strong>
                              {item.instructions ? <small>Note: {item.instructions}</small> : null}
                            </span>
                            <b>{formatNaira(item.lineTotal)}</b>
                          </div>
                        ))}
                      </div>
                      {selectedOrder.instructions ? (
                        <div className={styles.orderNote}><strong>Order note</strong><p>{selectedOrder.instructions}</p></div>
                      ) : null}
                      {selectedOrder.rider?.name ? (
                        <div className={styles.riderLine}>
                          <span className={styles.vendorAvatarSmall}>{initials(selectedOrder.rider.name)}</span>
                          <span><small>Assigned rider</small><strong>{selectedOrder.rider.name}</strong></span>
                        </div>
                      ) : null}
                      <footer className={styles.orderTotal}>
                        <span>Product subtotal</span><strong>{formatNaira(selectedOrder.itemsSubtotal)}</strong>
                      </footer>
                      <div className={styles.orderActions}>
                        {['placed', 'vendor_reviewing'].includes(selectedOrder.status) ? (
                          <>
                            <button className={styles.primaryButton} type="button" disabled={busyKey === selectedOrder.id} onClick={() => void orderAction(selectedOrder, 'accept')}>Accept order</button>
                            <button className={styles.dangerButton} type="button" disabled={busyKey === selectedOrder.id} onClick={() => setRejecting(selectedOrder)}>Reject</button>
                          </>
                        ) : null}
                        {selectedOrder.status === 'accepted' ? (
                          <button className={styles.primaryButton} type="button" disabled={busyKey === selectedOrder.id} onClick={() => void orderAction(selectedOrder, 'prepare')}>Start preparing</button>
                        ) : null}
                        {selectedOrder.status === 'preparing' ? (
                          <button className={styles.primaryButton} type="button" disabled={busyKey === selectedOrder.id} onClick={() => void orderAction(selectedOrder, 'ready')}>Mark ready</button>
                        ) : null}
                        {['ready', 'rider_assigned'].includes(selectedOrder.status) ? (
                          <button className={styles.primaryButton} type="button" disabled={busyKey === selectedOrder.id} onClick={() => setVerifying(selectedOrder)}>Verify pickup code</button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <EmptyState icon="orders" title="Select an order" body="Its items and fulfilment controls will appear here." />
                  )}
                </div>
              </section>
            </div>
          ) : null}

          {vendor && section === 'catalog' ? (
            <div className={styles.pageStack}>
              <section className={styles.toolbar}>
                <label className={styles.searchBox}>
                  <Icon name="search" size={18} />
                  <input value={query} placeholder="Search products or sections" onChange={(event) => setQuery(event.target.value)} />
                </label>
                <div className={styles.toolbarButtons}>
                  <button className={styles.secondaryButton} type="button" disabled={!canCatalogWrite} onClick={() => setCategoryForm(true)}>New section</button>
                  <button className={styles.primaryButton} type="button" disabled={!canCatalogWrite || vendor.categories.length === 0} onClick={() => setProductForm('new')}><Icon name="plus" size={17} />Add product</button>
                </div>
              </section>
              {vendor.categories.map((category) => {
                const items = category.items.filter((item) => visibleItems.some((visible) => visible.id === item.id));
                if (query.trim() && items.length === 0) return null;
                return (
                  <section className={styles.catalogSection} key={category.id}>
                    <header>
                      <div><h2>{category.name}</h2><p>{category.description ?? category.items.length + ' products'}</p></div>
                      <span>{category.items.length}</span>
                    </header>
                    <div className={styles.productGrid}>
                      {items.map((item) => {
                        const image = directImageUrl(item.imageKey);
                        return (
                          <article className={styles.productCard} key={item.id}>
                            <div className={styles.productMedia}>
                              {image ? <img src={image} alt="" /> : <span><Icon name="image" size={28} /></span>}
                              <button type="button" aria-label={'Edit ' + item.name} disabled={!canCatalogWrite} onClick={() => setProductForm(item)}><Icon name="edit" size={16} /></button>
                            </div>
                            <div className={styles.productBody}>
                              <StatusPill value={item.isAvailable ? 'open' : 'unavailable'} />
                              <h3>{item.name}</h3>
                              <p>{item.description ?? 'No description yet.'}</p>
                              <footer><strong>{formatNaira(item.price)}</strong><small>{item.prepMinutes} min</small></footer>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    {category.items.length === 0 ? <EmptyState icon="catalog" title="This section is empty" body="Add its first real product when the menu is ready." /> : null}
                  </section>
                );
              })}
              {vendor.categories.length === 0 ? (
                <EmptyState
                  icon="catalog"
                  title="Build your first catalog section"
                  body="Create a section such as Main meals, Drinks, Phones or Essentials, then add products."
                  action={canCatalogWrite ? <button className={styles.primaryButton} type="button" onClick={() => setCategoryForm(true)}>Create section</button> : null}
                />
              ) : null}
            </div>
          ) : null}

          {vendor && section === 'inventory' ? (
            <div className={styles.pageStack}>
              <section className={styles.inventorySummary}>
                <div><span>{allItems.length}</span><small>Total products</small></div>
                <div><span>{allItems.length - unavailableCount}</span><small>Available</small></div>
                <div><span>{unavailableCount}</span><small>Unavailable</small></div>
              </section>
              <section className={styles.tablePanel}>
                <header className={styles.tableHeader}>
                  <label className={styles.searchBox}><Icon name="search" size={18} /><input value={query} placeholder="Search inventory" onChange={(event) => setQuery(event.target.value)} /></label>
                  <span>{selectedBranch?.name ?? 'All branches'}</span>
                </header>
                <div className={styles.inventoryTable} role="table" aria-label="Product inventory">
                  <div className={styles.inventoryHead} role="row">
                    <span>Product</span><span>Section</span><span>Quantity</span><span>Updated</span><span>Available</span>
                  </div>
                  {visibleItems.map((item) => {
                    const stock = item.stock.find((entry) => entry.branchId === selectedBranch?.id);
                    const available = stock ? stock.isAvailable && item.isAvailable : item.isAvailable;
                    return (
                      <div className={styles.inventoryRow} role="row" key={item.id}>
                        <span><b>{item.name}</b><small>{formatNaira(item.price)}</small></span>
                        <span>{item.categoryName}</span>
                        <span>{stock?.quantity ?? 'Not tracked'}</span>
                        <span>{formatDate(stock?.updatedAt ?? item.updatedAt)}</span>
                        <span>
                          <button type="button" role="switch" aria-checked={available} aria-label={'Set ' + item.name + ' availability'} disabled={!canInventoryWrite || busyKey === 'item-' + item.id} className={available ? styles.toggleOn : styles.toggleOff} onClick={() => void setAvailability(item, !available)}><i /></button>
                        </span>
                      </div>
                    );
                  })}
                </div>
                {visibleItems.length === 0 ? <EmptyState icon="inventory" title="No products found" body="Try another search." /> : null}
              </section>
            </div>
          ) : null}

          {vendor && section === 'analytics' ? (
            <div className={styles.pageStack}>
              <section className={styles.toolbar}>
                <div className={styles.segmented}>
                  {[7, 30, 90].map((days) => (
                    <button key={days} type="button" className={reportDays === days ? styles.segmentSelected : ''} onClick={() => setReportDays(days)}>{days} days</button>
                  ))}
                </div>
              </section>
              {report ? (
                <>
                  <section className={styles.metricsGrid}>
                    <MetricCard label="Product revenue" value={formatNaira(report.itemsRevenue)} note="Delivery and platform fees excluded" tone="bronze" />
                    <MetricCard label="Delivered" value={String(report.orders.delivered)} note="Completed successfully" tone="green" />
                    <MetricCard label="Rejected" value={String(report.orders.rejected)} note={report.rejectionRate.toFixed(1) + '% rejection rate'} />
                    <MetricCard label="Cancelled" value={String(report.orders.cancelled)} note="Stopped after placement" />
                  </section>
                  <section className={styles.analyticsGrid}>
                    <article className={styles.panel}>
                      <header className={styles.panelHeader}><div><p className={styles.eyebrow}>Fulfilment quality</p><h2>Order outcomes</h2></div></header>
                      <div className={styles.outcomeBars}>
                        {[
                          ['Delivered', report.orders.delivered, styles.barSuccess],
                          ['Rejected', report.orders.rejected, styles.barDanger],
                          ['Cancelled', report.orders.cancelled, styles.barMuted],
                        ].map(([label, value, barClass]) => {
                          const count = Number(value);
                          const percentage = report.orders.total === 0 ? 0 : Math.round((count / report.orders.total) * 100);
                          return (
                            <div key={String(label)}>
                              <header><span>{label}</span><b>{count} · {percentage}%</b></header>
                              <div><i className={String(barClass)} style={{ width: percentage + '%' }} /></div>
                            </div>
                          );
                        })}
                      </div>
                    </article>
                    <article className={styles.insightCard}>
                      <p className={styles.eyebrow}>What this means</p>
                      <h2>
                        {report.orders.total === 0
                          ? 'Your first completed orders will unlock performance trends.'
                          : report.rejectionRate <= 5
                            ? 'Fulfilment is healthy.'
                            : 'Availability needs attention.'}
                      </h2>
                      <p>
                        {report.orders.total === 0
                          ? 'No figures are invented. DASH will build this view from real paid orders.'
                          : report.rejectionRate <= 5
                            ? 'Customers are receiving most orders without vendor rejection.'
                            : 'Review unavailable products and branch capacity to reduce rejected orders.'}
                      </p>
                    </article>
                  </section>
                </>
              ) : <EmptyState icon="analytics" title="Analytics are loading" body="This account may need report permission." />}
            </div>
          ) : null}

          {vendor && section === 'promotions' ? (
            <div className={styles.pageStack}>
              <section className={styles.promotionHero}>
                <div>
                  <p className={styles.eyebrow}>Vendor-funded growth</p>
                  <h2>Reach more customers without losing control of margin.</h2>
                  <p>The approved workspace is ready. Publishing stays locked until commission, funding share, quota and refund rules are connected to the promotion API.</p>
                  <button className={styles.primaryButton} type="button" disabled>Create promotion</button>
                </div>
                <div className={styles.promoPreview}>
                  <span>Campaign preview</span><strong>20% OFF</strong><p>Your storefront · New customers</p><small>Preview only — nothing has been published</small>
                </div>
              </section>
              <section className={styles.panel}>
                <header className={styles.panelHeader}><div><p className={styles.eyebrow}>Commercial safeguard</p><h2>Before publishing is enabled</h2></div></header>
                <div className={styles.checklist}>
                  <span><b>1</b><div><strong>Funding source</strong><small>Vendor, DASH, or a defined split</small></div></span>
                  <span><b>2</b><div><strong>Eligibility & quota</strong><small>Who qualifies and how many times</small></div></span>
                  <span><b>3</b><div><strong>Refund behaviour</strong><small>Discount responsibility stays auditable</small></div></span>
                </div>
              </section>
            </div>
          ) : null}

          {vendor && section === 'reviews' ? (
            <div className={styles.pageStack}>
              <section className={styles.reviewSummary}>
                <div>
                  <strong>{vendor.ratingCount > 0 ? vendor.ratingAverage.toFixed(1) : '—'}</strong>
                  <span className={styles.stars}>★★★★★</span>
                  <small>{vendor.ratingCount} published ratings</small>
                </div>
                <aside>
                  <p className={styles.eyebrow}>DASH support</p><h2>Need help with an order?</h2>
                  <p>Order-specific support messaging will connect here with the support-case milestone.</p>
                  <button className={styles.secondaryButton} type="button" disabled>Contact support</button>
                </aside>
              </section>
              <section className={styles.reviewList}>
                {vendor.reviews.map((review) => (
                  <article key={review.id}>
                    <header>
                      <span className={styles.vendorAvatarSmall}>{initials(review.customerName)}</span>
                      <div><strong>{review.customerName}</strong><small>{review.orderCode} · {formatDate(review.createdAt)}</small></div>
                      <span className={styles.reviewStars}>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span>
                    </header>
                    <p>{review.comment ?? 'This customer left a rating without a written comment.'}</p>
                    {review.vendorResponse ? <blockquote><strong>Your response</strong><span>{review.vendorResponse}</span></blockquote> : null}
                    <button className={styles.textButton} type="button" disabled={!canReviewRespond} onClick={() => setReviewForm(review)}>
                      {review.vendorResponse ? 'Edit response' : 'Reply to review'}
                    </button>
                  </article>
                ))}
                {vendor.reviews.length === 0 ? <EmptyState icon="review" title="No reviews yet" body="Verified customer feedback will appear here after delivered orders." /> : null}
              </section>
            </div>
          ) : null}

          {vendor && section === 'profile' ? (
            <div className={styles.pageStack}>
              <section className={styles.profileHero}>
                <span className={styles.businessAvatar}>{initials(vendor.name)}</span>
                <div>
                  <StatusPill value={vendor.status} />
                  <h2>{vendor.name}</h2>
                  <p>{vendor.description ?? 'Add a customer-facing business description when settings editing is connected.'}</p>
                  <small>{titleCase(vendor.category)} · dash.app/{vendor.slug}</small>
                </div>
                <button className={styles.secondaryButton} type="button" disabled><Icon name="edit" size={17} />Edit business</button>
              </section>
              <section className={styles.settingsGrid}>
                <article className={styles.panel}>
                  <header className={styles.panelHeader}><div><p className={styles.eyebrow}>Locations</p><h2>Branches</h2></div></header>
                  <div className={styles.branchList}>
                    {branches.map((branch) => (
                      <div key={branch.id}>
                        <span className={styles.branchIcon}><Icon name="store" size={18} /></span>
                        <span><strong>{branch.name}</strong><small>{branch.address}</small></span>
                        <StatusPill value={branch.state} />
                      </div>
                    ))}
                  </div>
                </article>
                <article className={styles.panel}>
                  <header className={styles.panelHeader}><div><p className={styles.eyebrow}>Settlements</p><h2>Payout account</h2></div></header>
                  {!canReadPayout ? (
                    <p className={styles.mutedCopy}>Only the vendor owner can view settlement details.</p>
                  ) : payout?.configured ? (
                    <div className={styles.payoutCard}><span>{payout.bankName}</span><strong>{payout.accountNumberMasked}</strong><small>Account number is never returned in full.</small></div>
                  ) : <EmptyState icon="profile" title="No payout account" body="A verified owner can add one after step-up authentication." />}
                </article>
              </section>
              <section className={styles.securityBand}>
                <div><strong>Role-based access</strong><p>This session has {permissions.size} explicit permissions. Every record is still checked against this vendor and branch.</p></div>
                <StatusPill value="protected" />
              </section>
            </div>
          ) : null}
        </main>
      </div>

      <nav className={styles.mobileNav} aria-label="Vendor navigation">
        {NAV_ITEMS.slice(0, 5).map((item) => (
          <button key={item.id} type="button" className={section === item.id ? styles.mobileNavActive : ''} onClick={() => setSection(item.id)}>
            <Icon name={item.icon} size={19} /><span>{item.label}</span>
            {item.id === 'orders' && incomingCount > 0 ? <b>{incomingCount}</b> : null}
          </button>
        ))}
        <button type="button" className={['promotions', 'reviews', 'profile'].includes(section) ? styles.mobileNavActive : ''} onClick={() => setSection('profile')}>
          <Icon name="profile" size={19} /><span>More</span>
        </button>
      </nav>

      {productForm ? (
        <ProductForm categories={vendor?.categories ?? []} item={productForm === 'new' ? null : productForm} canWrite={canCatalogWrite} onClose={() => setProductForm(null)} onSaved={loadDashboard} />
      ) : null}
      {categoryForm ? <CategoryForm onClose={() => setCategoryForm(false)} onSaved={loadDashboard} /> : null}
      {reviewForm ? <ReviewResponseForm review={reviewForm} onClose={() => setReviewForm(null)} onSaved={loadDashboard} /> : null}
      {rejecting ? (
        <RejectDialog
          order={rejecting}
          onClose={() => setRejecting(null)}
          onDone={loadOrders}
        />
      ) : null}
      {verifying ? (
        <PickupDialog
          order={verifying}
          onClose={() => setVerifying(null)}
          onDone={loadOrders}
        />
      ) : null}
    </div>
  );
}
