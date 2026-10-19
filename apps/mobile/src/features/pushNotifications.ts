/**
 * What a DASH push means to the app: where tapping it goes, whether it is
 * shown while the app is open, and when to ask Android for permission.
 *
 * A push carries identifiers only — a type, which side of the app it is for,
 * and an order, offer or support conversation id (see packages/domain/src/
 * push). Everything else is read from the API once the screen opens, through
 * routes that check who is asking. So nothing here trusts a push for more than
 * where to go: a forged or stale one at worst opens a screen that then shows
 * "not found".
 *
 * Pure: tested directly, with no native module in sight.
 */

import {
  CUSTOMER_TABS,
  RIDER_TABS,
  createNavigationState,
  navigate,
  selectTab,
  type AppFace,
  type AppRoute,
  type NavigationState,
  type RouteName,
} from '../v2/navigation/model';

export type PushType = 'rider_offer' | 'order_update' | 'order_chat' | 'support_reply' | 'payment_update';

export interface PushData {
  type: PushType;
  audience: AppFace;
  orderId?: string;
  offerId?: string;
  conversationId?: string;
  status?: string;
}

const TYPES: ReadonlySet<string> = new Set(['rider_offer', 'order_update', 'order_chat', 'support_reply', 'payment_update']);
/** Ids are short and plain. Anything else is not from DASH. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const text = (value: unknown): string | undefined => (typeof value === 'string' && ID.test(value) ? value : undefined);

/**
 * The push's data, or null if it is not a DASH push the app understands. An
 * offer names no audience — only riders are offered work.
 */
export function readPushData(raw: unknown): PushData | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string' || !TYPES.has(type)) return null;
  const audience = type === 'rider_offer' ? 'rider' : record['audience'];
  if (audience !== 'customer' && audience !== 'rider') return null;

  const data: PushData = { type: type as PushType, audience };
  const orderId = text(record['orderId']);
  const offerId = text(record['offerId']);
  const conversationId = text(record['conversationId']);
  const status = text(record['status']);
  if (orderId) data.orderId = orderId;
  if (offerId) data.offerId = offerId;
  if (conversationId) data.conversationId = conversationId;
  if (status) data.status = status;

  // Each type needs the id it is about.
  if ((type === 'order_update' || type === 'order_chat' || type === 'payment_update') && !data.orderId) return null;
  if (type === 'support_reply' && !data.conversationId) return null;
  return data;
}

/** Who is signed in, as far as opening a screen is concerned. */
export interface PushViewer {
  customerId: string | null;
  riderStatus: string | null;
}

export interface PushTarget {
  face: AppFace;
  /** Opened in order, on top of the face's current screens. */
  routes: AppRoute[];
}

/**
 * Where tapping a push goes, or null to just open the app. Only for a signed-
 * in person who has the side of the app the push is for: a rider push on a
 * phone now signed in as a customer-only account opens nothing in particular.
 */
export function notificationTarget(data: PushData | null, viewer: PushViewer | null): PushTarget | null {
  if (!data || !viewer) return null;
  if (data.audience === 'rider' && viewer.riderStatus !== 'approved') return null;
  if (data.audience === 'customer' && !viewer.customerId) return null;

  const order = data.orderId ? { id: data.orderId } : undefined;
  if (data.audience === 'rider') {
    switch (data.type) {
      // The live workspace shows the rider's real state — the offer, or the
      // delivery — whatever the push said.
      case 'rider_offer':
        return { face: 'rider', routes: [{ name: 'rider.online' }] };
      case 'order_update':
        return { face: 'rider', routes: [{ name: 'rider.orders' }] };
      case 'order_chat':
        return order ? { face: 'rider', routes: [{ name: 'rider.online' }, { name: 'rider.chat', params: order }] } : null;
      case 'support_reply':
        return { face: 'rider', routes: [{ name: 'rider.support-chat' }] };
      default:
        return null;
    }
  }

  switch (data.type) {
    case 'order_update':
    case 'payment_update':
      return order ? { face: 'customer', routes: [{ name: 'customer.track-order', params: order }] } : null;
    case 'order_chat':
      return order
        ? { face: 'customer', routes: [{ name: 'customer.track-order', params: order }, { name: 'customer.chat', params: order }] }
        : null;
    case 'support_reply':
      return { face: 'customer', routes: [{ name: 'customer.support-chat' }] };
    default:
      return null;
  }
}

const TABS: ReadonlySet<string> = new Set([...CUSTOMER_TABS, ...RIDER_TABS].map((tab) => tab.name));

/**
 * The navigation state after opening a tapped push, or null to stay put.
 * On the same face the screens open on top of what is showing, so Back
 * returns there; on the other face the app switches, as the Profile switch
 * does — except that a rider with a delivery in progress stays on it, which
 * is the rule the Profile switch follows too.
 */
export function openPushTarget(
  state: NavigationState,
  target: PushTarget,
  guard: { riderApproved: boolean; deliveryInProgress: boolean; deliveryRestoring?: boolean },
): NavigationState | null {
  if (target.face === 'rider' && !guard.riderApproved) return null;
  if (target.face !== state.face && state.face === 'rider' && (guard.deliveryInProgress || guard.deliveryRestoring)) return null;
  let next = target.face === state.face ? state : createNavigationState(target.face);
  for (const route of target.routes) next = TABS.has(route.name) ? selectTab(next, route) : navigate(next, route);
  return next;
}

/** The routes that render the rider's live workspace, which shows an offer itself. */
const RIDER_WORKSPACE: ReadonlySet<RouteName> = new Set(['rider.online', 'rider.offer', 'rider.delivery', 'rider.route', 'rider.complete']);

/**
 * Whether a push that arrives while the app is open is shown as a banner.
 * Not when the screen in front of the person already shows what it is about —
 * that would be the same news twice. Everywhere else it is shown, because the
 * app's own polling only updates the screen that is open.
 */
export function showInForeground(data: PushData | null, current: { face: AppFace; route: AppRoute } | null): boolean {
  if (!data) return true;
  if (!current) return true;
  const { route } = current;
  const sameOrder = Boolean(data.orderId) && route.params?.['id'] === data.orderId;

  switch (data.type) {
    case 'rider_offer':
      // The rider face shows a live offer banner on every screen.
      return current.face !== 'rider';
    case 'order_update':
      if (data.audience === 'rider') return !RIDER_WORKSPACE.has(route.name);
      return !(route.name === 'customer.track-order' && sameOrder);
    case 'order_chat':
      return !((route.name === 'customer.chat' || route.name === 'rider.chat') && sameOrder);
    case 'support_reply':
      return route.name !== `${data.audience}.support-chat`;
    default:
      return true;
  }
}

export interface PermissionFacts {
  granted: boolean;
  canAskAgain: boolean;
  /** The phone's Notifications switch for this account. */
  enabled: boolean;
  /** Whether DASH has already asked once on this phone, unprompted. */
  askedBefore: boolean;
  /** The person just turned the switch on themselves. */
  userAsked: boolean;
}

/**
 * What to do about Android's notification permission. DASH asks once, on its
 * own, after sign-in — and again only when the person turns the switch on.
 * It never asks someone who has switched notifications off.
 */
export function permissionStep(facts: PermissionFacts): 'register' | 'ask' | 'wait' {
  if (facts.granted) return 'register';
  if (!facts.enabled || !facts.canAskAgain) return 'wait';
  if (facts.userAsked || !facts.askedBefore) return 'ask';
  return 'wait';
}
