/**
 * The DASH Wallet: the balance and history from DASH's ledger, and the cards
 * saved through the payment provider.
 *
 * Adding a card happens on the provider's own secure page, opened in the
 * browser; the card number never touches the app or DASH. Coming back to the
 * app asks the server how it went. The server keeps only the provider's token
 * for the card, encrypted, and the app sees only brand, last four and expiry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Pressable, View } from 'react-native';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api, ApiError } from '../../api';
import {
  confirmCardSetup,
  getWallet,
  listCards,
  makeCardDefault,
  removeCard,
  startCardSetup,
  type SavedCard,
  type WalletSummary,
  type WalletTransaction,
} from '../../data/wallet';
import { cardExpiry, cardTitle, setupOutcomeMessage } from '../../features/wallet';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { ErrorState } from '../../ui/Display';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from '../orders/parts';

const transactionLabel = (transaction: WalletTransaction): string => {
  switch (transaction.kind) {
    case 'wallet_topup':
      return 'Wallet top-up';
    case 'promotion_credit':
      return 'DASH credit';
    case 'order_refund':
      return 'Refund';
    case 'wallet_spend':
      return 'Order payment';
    default:
      return transaction.memo.replace(/_/g, ' ');
  }
};

const describeError = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? (error.isNetwork ? 'DASH could not be reached. Check your connection and try again.' : error.message) : fallback;

export function WalletScreen({ onAccount }: { onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const signedIn = api.configured && auth.state === 'authenticated';
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!signedIn) {
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setWallet(await getWallet(api));
    } catch (caught) {
      setError(describeError(caught, 'Could not load your DASH Wallet.'));
    } finally {
      setBusy(false);
    }
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <OrderPage testID="customer-wallet-v2">
      <View style={{ height: 54, justifyContent: 'center' }}>
        <Text variant="title">DASH Wallet</Text>
      </View>

      {!api.configured ? (
        <Empty icon="cloud-off-outline" title="Not connected to DASH" body="This build has no DASH API address, so your wallet cannot be loaded." />
      ) : null}

      {api.configured && auth.state !== 'authenticated' ? (
        <Empty
          icon="account-lock-outline"
          title="Sign in to see your wallet"
          body="Your wallet balance, cards and transaction history belong to your secured DASH account."
          action="Open account"
          onPress={onAccount}
        />
      ) : null}

      {signedIn && busy && !wallet ? (
        <View style={{ minHeight: 180, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={palette.accent} accessibilityLabel="Loading your wallet" />
        </View>
      ) : null}

      {signedIn && error && !wallet ? <ErrorState title="Couldn’t load your wallet" message={error} onRetry={() => void load()} /> : null}

      {wallet ? (
        <>
          <Card>
            <Text variant="caption" tone="muted">Available balance</Text>
            <Text variant="display">{formatNairaCompact(wallet.balance as Kobo)}</Text>
            <Text variant="micro" tone="muted">Your balance comes from DASH’s server ledger. The app never invents or calculates money locally.</Text>
          </Card>
        </>
      ) : null}

      {signedIn ? <SavedCards /> : null}

      {wallet ? (
        <>
          <Text variant="heading">Transactions</Text>
          {wallet.transactions.length === 0 ? (
            <Empty icon="wallet-outline" title="No wallet activity yet" body="Wallet credits, refunds and wallet spending will appear here when they happen." />
          ) : (
            wallet.transactions.map((transaction) => {
              const incoming = transaction.amount >= 0;
              return (
                <Card key={transaction.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                    <View style={{ flex: 1 }}>
                      <Text variant="label" weight="bold">{transactionLabel(transaction)}</Text>
                      <Text variant="micro" tone="muted">{new Date(transaction.occurredAt).toLocaleDateString()}</Text>
                    </View>
                    <Text variant="label" weight="bold" style={{ color: incoming ? palette.success : palette.text }}>
                      {incoming ? '+' : '−'}
                      {formatNairaCompact(Math.abs(transaction.amount) as Kobo)}
                    </Text>
                  </View>
                </Card>
              );
            })
          )}
        </>
      ) : null}
    </OrderPage>
  );
}

/** Saved cards, and adding one on the provider's page. */
function SavedCards() {
  const { palette } = useTheme();
  const [cards, setCards] = useState<SavedCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const [working, setWorking] = useState<'adding' | 'checking' | string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: 'success' | 'waiting' | 'problem' } | null>(null);
  const busy = useRef(false);
  const pendingRef = useRef<string | null>(null);

  const setPending = (reference: string | null) => {
    pendingRef.current = reference;
    setPendingReference(reference);
  };

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await listCards(api);
      setCards(result.methods);
      setPending(result.pendingSetup?.reference ?? null);
      return result.pendingSetup?.reference ?? null;
    } catch (caught) {
      setLoadError(describeError(caught, 'Could not load your saved cards.'));
      return null;
    }
  }, []);

  const check = useCallback(
    async (reference: string) => {
      if (busy.current) return;
      busy.current = true;
      setWorking('checking');
      try {
        const outcome = await confirmCardSetup(api, reference);
        setNote(setupOutcomeMessage(outcome));
        if (outcome.status !== 'pending') {
          setPending(null);
          await load();
        }
      } catch (caught) {
        setNote({ text: describeError(caught, 'Your card could not be checked just now.'), tone: 'problem' });
      } finally {
        busy.current = false;
        setWorking(null);
      }
    },
    [load],
  );

  useEffect(() => {
    void load().then((reference) => {
      // A setup left half-way — the app was closed on the payment page —
      // is checked as soon as the wallet opens again.
      if (reference) void check(reference);
    });
  }, [check, load]);

  // Back from the payment page: ask how it went.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && pendingRef.current) void check(pendingRef.current);
    });
    return () => subscription.remove();
  }, [check]);

  const add = async () => {
    if (busy.current) return;
    busy.current = true;
    setWorking('adding');
    setNote(null);
    try {
      const setup = await startCardSetup(api);
      setPending(setup.reference);
      await Linking.openURL(setup.authorizationUrl);
      setNote({ text: 'Finish adding your card on the secure payment page, then come back here.', tone: 'waiting' });
    } catch (caught) {
      setNote({ text: describeError(caught, 'The secure payment page could not be opened.'), tone: 'problem' });
    } finally {
      busy.current = false;
      setWorking(null);
    }
  };

  const act = async (id: string, run: () => Promise<SavedCard[]>, done: string) => {
    if (busy.current) return;
    busy.current = true;
    setWorking(id);
    setNote(null);
    try {
      setCards(await run());
      setNote({ text: done, tone: 'success' });
    } catch (caught) {
      setNote({ text: describeError(caught, 'That did not go through. Please try again.'), tone: 'problem' });
    } finally {
      busy.current = false;
      setWorking(null);
    }
  };

  const confirmRemove = (card: SavedCard) => {
    Alert.alert('Remove this card?', `${cardTitle(card)} will be removed from DASH.`, [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void act(card.id, () => removeCard(api, card.id), 'Card removed.') },
    ]);
  };

  return (
    <View style={{ gap: space.sm }}>
      <Text variant="heading">Payment cards</Text>
      {loadError ? <ErrorState title="Couldn’t load your cards" message={loadError} onRetry={() => void load()} /> : null}
      {!loadError && cards === null ? <ActivityIndicator color={palette.accent} accessibilityLabel="Loading your cards" /> : null}

      {cards?.length === 0 && !pendingReference ? (
        <Card>
          <Text variant="label" weight="bold">No saved cards yet</Text>
          <Text variant="caption" tone="muted">Save a card to pay faster. You add it on Paystack’s secure page — DASH never sees your card number.</Text>
        </Card>
      ) : null}

      {cards?.map((card) => {
        const expiry = cardExpiry(card);
        return (
          <Card key={card.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="credit-card-outline" color={palette.accent} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                  <Text variant="label" weight="bold">{cardTitle(card)}</Text>
                  {card.isDefault ? (
                    <View style={{ paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: palette.successSoft }}>
                      <Text variant="micro" weight="bold" tone="success">Default</Text>
                    </View>
                  ) : null}
                </View>
                <Text variant="caption" tone={expiry.expired ? 'danger' : 'muted'}>{expiry.label}{card.bank ? ` · ${card.bank}` : ''}</Text>
              </View>
              {working === card.id ? <ActivityIndicator color={palette.accent} /> : null}
            </View>
            <View style={{ flexDirection: 'row', gap: space.xs, marginLeft: -space.sm }}>
              {!card.isDefault ? (
                <TextAction label="Make default" onPress={() => void act(card.id, () => makeCardDefault(api, card.id), 'Default card updated.')} disabled={working !== null} />
              ) : null}
              <TextAction label="Remove" danger onPress={() => confirmRemove(card)} disabled={working !== null} />
            </View>
          </Card>
        );
      })}

      {pendingReference ? (
        <Card>
          <Text variant="label" weight="bold">Adding a card</Text>
          <Text variant="caption" tone="muted">Finish on the secure payment page, then come back. We check as soon as you return.</Text>
          <SecondaryButton label={working === 'checking' ? 'Checking…' : 'Check again'} onPress={() => void check(pendingReference)} disabled={working !== null} />
        </Card>
      ) : null}

      {note ? <Notice icon={note.tone === 'success' ? 'check-circle-outline' : note.tone === 'waiting' ? 'clock-outline' : 'alert-circle-outline'} text={note.text} danger={note.tone === 'problem'} /> : null}

      {cards !== null ? (
        <PrimaryCheckoutButton label={working === 'adding' ? 'Opening secure page…' : pendingReference ? 'Start again' : 'Add a card'} onPress={() => void add()} disabled={working !== null} busy={working === 'adding'} />
      ) : null}
      <Text variant="micro" tone="muted">Adding a card takes a ₦50 verification charge on Paystack, refunded once the card is saved. DASH keeps only Paystack’s secure reference and the last four digits.</Text>
    </View>
  );
}

function TextAction({ label, onPress, disabled, danger = false }: { label: string; onPress: () => void; disabled: boolean; danger?: boolean }) {
  const { palette } = useTheme();
  const color = danger ? palette.danger : palette.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({ minHeight: touchTarget, paddingHorizontal: space.sm, justifyContent: 'center', borderRadius: radius.sm, opacity: disabled ? 0.45 : pressed ? 0.6 : 1 })}
    >
      <Text variant="caption" weight="bold" style={{ color }}>{label}</Text>
    </Pressable>
  );
}
