export type AppFace = 'customer' | 'rider';

export type CustomerRoute =
  | 'customer.home'
  | 'customer.orders'
  | 'customer.wallet'
  | 'customer.support'
  | 'customer.account'
  | 'customer.notifications'
  | 'customer.search'
  | 'customer.category'
  | 'customer.declutter-listing'
  | 'customer.store'
  | 'customer.product'
  | 'customer.cart'
  | 'customer.checkout'
  | 'customer.track-order'
  | 'customer.chat'
  | 'customer.register'
  | 'customer.delete-account'
  | 'customer.legal'
  | 'customer.rider-apply'
  | 'customer.personal-details'
  | 'customer.addresses'
  | 'customer.notification-settings'
  | 'customer.help'
  | 'customer.delivery-location'
  | 'customer.support-chat';

export type RiderRoute =
  | 'rider.home'
  | 'rider.earnings'
  | 'rider.orders'
  | 'rider.inbox'
  | 'rider.profile'
  | 'rider.online'
  | 'rider.offer'
  | 'rider.delivery'
  | 'rider.history-detail'
  | 'rider.route'
  | 'rider.complete'
  | 'rider.chat'
  | 'rider.personal-details'
  | 'rider.notification-settings'
  | 'rider.help'
  | 'rider.legal'
  | 'rider.bank-account'
  | 'rider.support-chat';

export type RouteName = CustomerRoute | RiderRoute;

export interface AppRoute {
  name: RouteName;
  params?: Readonly<Record<string, string>>;
}

export interface NavigationState {
  face: AppFace;
  stack: readonly AppRoute[];
}

export const CUSTOMER_TABS = [
  { name: 'customer.home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { name: 'customer.orders', label: 'Orders', icon: 'receipt-text-outline', activeIcon: 'receipt-text' },
  { name: 'customer.wallet', label: 'Wallet', icon: 'wallet-outline', activeIcon: 'wallet' },
  { name: 'customer.support', label: 'Support', icon: 'message-question-outline', activeIcon: 'message-question' },
] as const;

export const RIDER_TABS = [
  { name: 'rider.home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { name: 'rider.earnings', label: 'Earnings', icon: 'chart-line', activeIcon: 'chart-areaspline' },
  { name: 'rider.orders', label: 'Orders', icon: 'clipboard-text-outline', activeIcon: 'clipboard-text' },
  { name: 'rider.inbox', label: 'Inbox', icon: 'inbox-outline', activeIcon: 'inbox' },
  { name: 'rider.profile', label: 'Profile', icon: 'account-outline', activeIcon: 'account' },
] as const;

export function rootRoute(face: AppFace): AppRoute {
  return { name: face === 'customer' ? 'customer.home' : 'rider.home' };
}

export function routeFace(route: AppRoute): AppFace {
  return route.name.startsWith('customer.') ? 'customer' : 'rider';
}

export function createNavigationState(face: AppFace = 'customer'): NavigationState {
  return { face, stack: [rootRoute(face)] };
}

export function navigate(state: NavigationState, route: AppRoute): NavigationState {
  if (routeFace(route) !== state.face) {
    throw new Error(`Cannot open ${route.name} while the ${state.face} face is active.`);
  }
  const current = state.stack[state.stack.length - 1];
  if (current?.name === route.name && JSON.stringify(current.params) === JSON.stringify(route.params)) return state;
  return { ...state, stack: [...state.stack, route] };
}

export function selectTab(state: NavigationState, route: AppRoute): NavigationState {
  if (routeFace(route) !== state.face) {
    throw new Error(`Cannot select ${route.name} while the ${state.face} face is active.`);
  }
  return { ...state, stack: [route] };
}

export function goBack(state: NavigationState): NavigationState {
  if (state.stack.length <= 1) return state;
  return { ...state, stack: state.stack.slice(0, -1) };
}

export function switchFace(_state: NavigationState, face: AppFace): NavigationState {
  // Reset rather than retaining the other face's native tree. This is the key
  // invariant behind the crash-resistant one-app/two-faces architecture.
  return createNavigationState(face);
}

export function currentRoute(state: NavigationState): AppRoute {
  return state.stack[state.stack.length - 1] ?? rootRoute(state.face);
}
