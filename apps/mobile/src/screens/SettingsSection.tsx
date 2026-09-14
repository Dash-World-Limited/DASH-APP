/**
 * Account settings that belong to a later checkpoint, each saying what it will
 * do and what it is waiting on. Shared by the Customer and Rider profiles.
 *
 * Each face mounts it inside its own stack (app/(customer)/settings and
 * app/rider/settings) rather than once at the root: the root is a Slot, not a
 * stack, so a root screen would replace the whole face and Back would have
 * nowhere to return to (from the Rider face it would even land on the
 * Customer Home).
 */

import { Redirect, useLocalSearchParams } from 'expo-router';

import type { Href } from 'expo-router';

import type { IconName } from '../ui/Icon';
import { ComingScreen } from '../ui/ComingScreen';

const SECTIONS: Record<string, { title: string; icon: IconName; headline: string; body: string; waitingOn: string }> = {
  personal: {
    title: 'Personal Information',
    icon: 'account-outline',
    headline: 'Your details',
    body: 'Your name, phone number and email, as DASH holds them.',
    waitingOn: 'Editing your details arrives with account settings. Once signed in, your name and email already show on your profile.',
  },
  addresses: {
    title: 'Addresses',
    icon: 'map-marker-outline',
    headline: 'Where we deliver',
    body: 'Save home, work and other places, and choose where each order goes.',
    waitingOn: 'Saved addresses arrive with checkout. The address shown on Home is a staging sample until then.',
  },
  payments: {
    title: 'Payment Methods',
    icon: 'credit-card-outline',
    headline: 'How you pay',
    body: 'Your DASH Wallet, cards, bank transfer, USSD and pay on delivery.',
    waitingOn: 'Arrives with payments. Card details are only ever handled by the payment provider, never stored by this app.',
  },
  notifications: {
    title: 'Notifications',
    icon: 'bell-outline',
    headline: 'What we tell you about',
    body: 'Choose which order, delivery and offer updates reach your phone.',
    waitingOn: 'Arrives with push notifications for customers.',
  },
  language: {
    title: 'Language',
    icon: 'translate',
    headline: 'English for now',
    body: 'DASH is in English. Other languages will be offered as they are properly translated, not machine-guessed.',
    waitingOn: 'No other language is available yet.',
  },
  vehicle: {
    title: 'Vehicle & Documents',
    icon: 'card-account-details-outline',
    headline: 'Your vehicle and documents',
    body: 'Your vehicle type, licence and the documents DASH reviewed to approve you.',
    waitingOn: 'Arrives with rider onboarding and approval (the Rider operations milestone).',
  },
  zone: {
    title: 'Current Zone',
    icon: 'map-marker-radius',
    headline: 'Where you are approved to work',
    body: 'Your zone decides which offers reach you. It is set with DASH operations, and dispatch refuses pickups outside it.',
    waitingOn: 'Requesting a zone change arrives with rider onboarding. Zone rules are enforced by the server either way.',
  },
  bank: {
    title: 'Bank Account',
    icon: 'bank-outline',
    headline: 'Where your earnings go',
    body: 'The account DASH pays your earnings into.',
    waitingOn: 'Arrives with rider payouts. Bank details are verified before any payout is made.',
  },
};

/** `fallback` is where an unknown section sends you: that face's own profile. */
export function SettingsSection({ fallback }: { fallback: Href }) {
  const { section } = useLocalSearchParams<{ section: string }>();
  const copy = section ? SECTIONS[section] : undefined;
  if (!copy) return <Redirect href={fallback} />;
  return <ComingScreen {...copy} />;
}
