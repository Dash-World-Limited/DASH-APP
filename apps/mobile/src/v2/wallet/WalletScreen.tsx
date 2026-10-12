import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api, ApiError } from '../../api';
import { useTheme } from '../../theme/ThemeProvider';
import { space } from '../../theme/tokens';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { Card, Empty, Notice, OrderPage } from '../orders/parts';

interface WalletTransaction {
  id: string;
  amount: number;
  memo: string;
  kind: string;
  referenceType: string;
  referenceId: string;
  occurredAt: string;
  createdAt: string;
}

interface WalletResponse {
  currency: 'NGN';
  balance: number;
  transactions: WalletTransaction[];
}

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

export function WalletScreen({ onAccount }: { onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') {
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setWallet(await api.request<WalletResponse>('/v1/wallet'));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your DASH Wallet.');
    } finally {
      setBusy(false);
    }
  }, [auth.state]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <OrderPage>
      <View style={{ height: 54, justifyContent: 'center' }}>
        <Text variant="title">DASH Wallet</Text>
      </View>

      {!api.configured ? (
        <Empty
          icon="cloud-off-outline"
          title="Not connected to DASH"
          body="This build has no DASH API address, so your wallet cannot be loaded."
        />
      ) : null}

      {api.configured && auth.state !== 'authenticated' ? (
        <Empty
          icon="account-lock-outline"
          title="Sign in to see your wallet"
          body="Your wallet balance and transaction history belong to your secured DASH account."
          action="Open account"
          onPress={onAccount}
        />
      ) : null}

      {busy ? (
        <View style={{ minHeight: 180, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : null}

      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}

      {wallet ? (
        <>
          <Card>
            <Text variant="caption" tone="muted">Available balance</Text>
            <Text variant="display">{formatNairaCompact(wallet.balance as Kobo)}</Text>
            <Text variant="micro" tone="muted">
              Your balance comes from DASH’s server ledger. The app never invents or calculates money locally.
            </Text>
          </Card>

          <Text variant="heading">Transactions</Text>
          {wallet.transactions.length === 0 ? (
            <Empty
              icon="wallet-outline"
              title="No wallet activity yet"
              body="Wallet credits, refunds and wallet spending will appear here when they happen."
            />
          ) : (
            wallet.transactions.map((transaction) => {
              const incoming = transaction.amount >= 0;
              return (
                <Card key={transaction.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                    <View style={{ flex: 1 }}>
                      <Text variant="label" weight="bold">{transactionLabel(transaction)}</Text>
                      <Text variant="micro" tone="muted">
                        {new Date(transaction.occurredAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text
                      variant="label"
                      weight="bold"
                      style={{ color: incoming ? palette.success : palette.text }}
                    >
                      {incoming ? '+' : '−'}{formatNairaCompact(Math.abs(transaction.amount) as Kobo)}
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
