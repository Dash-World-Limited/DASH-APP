/**
 * Bank account, for riders: the account DASH pays their earnings into.
 *
 * The rider picks their bank from the payment provider's list and types the
 * account number. DASH asks the bank whose account it is and shows the name
 * the bank holds; the rider saves only after seeing it. The saved account is
 * shown masked — bank, name and the last four digits — and the full number
 * never comes back to the phone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { api, ApiError } from '../../api';
import {
  getPayoutAccount,
  listPayoutBanks,
  savePayoutAccount,
  verifyPayoutAccount,
  type PayoutAccount,
  type PayoutBank,
  type VerifiedPayoutAccount,
} from '../../data/payout';
import { accountNumberProblem, filterBanks, normaliseAccountNumber } from '../../features/payout';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { ErrorState } from '../../ui/Display';
import { TextField } from '../../ui/Fields';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from '../orders/parts';

const describeError = (error: unknown): string =>
  error instanceof ApiError
    ? error.isNetwork
      ? 'DASH could not be reached. Check your connection and try again.'
      : error.message
    : 'Something went wrong. Please try again.';

export function BankAccountScreen({ onBack }: { onBack: () => void }) {
  const { state: sessionState } = useAppSession();
  const [account, setAccount] = useState<PayoutAccount | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setAccount(await getPayoutAccount(api));
    } catch (caught) {
      setLoadError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    if (sessionState === 'authenticated') void load();
  }, [load, sessionState]);

  return (
    <OrderPage testID="rider-bank-account-v2">
      <BackHeader title="Bank account" onBack={onBack} />
      {sessionState !== 'authenticated' ? (
        <Empty icon="account-lock-outline" title="Sign in to manage your bank account" body="Your payout account belongs to your DASH rider account." />
      ) : loadError ? (
        <ErrorState title="Couldn’t load your bank account" message={loadError} onRetry={() => void load()} />
      ) : !account ? (
        <View style={{ minHeight: 200, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator accessibilityLabel="Loading your bank account" />
        </View>
      ) : editing ? (
        <AccountForm
          replacing={account.configured}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            setAccount(saved);
            setEditing(false);
            setSavedNote('Your bank account is saved. DASH will pay your earnings into it.');
          }}
        />
      ) : account.configured ? (
        <>
          <SavedAccount account={account} />
          {savedNote ? <Notice icon="check-circle-outline" text={savedNote} /> : null}
          <SecondaryButton label="Change bank account" onPress={() => { setSavedNote(null); setEditing(true); }} />
        </>
      ) : (
        <Empty
          icon="bank-outline"
          title="Add your bank account"
          body="This is where DASH pays your earnings. Your bank confirms the account name before it is saved."
          action="Add bank account"
          onPress={() => setEditing(true)}
        />
      )}
      <Text variant="micro" tone="muted">Only the last four digits of your account number are ever shown, here or to DASH staff.</Text>
    </OrderPage>
  );
}

function SavedAccount({ account }: { account: PayoutAccount }) {
  const { palette } = useTheme();
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="bank-outline" color={palette.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" weight="bold">{account.accountName}</Text>
          <Text variant="caption" tone="muted">{account.bankName} · {account.accountNumberMasked}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
        <Icon name="check-decagram" size={16} color={palette.success} />
        <Text variant="micro" tone="success">
          Confirmed by your bank{account.verifiedAt ? ` on ${new Date(account.verifiedAt).toLocaleDateString()}` : ''}
        </Text>
      </View>
    </Card>
  );
}

function AccountForm({ replacing, onCancel, onSaved }: { replacing: boolean; onCancel: () => void; onSaved: (account: PayoutAccount) => void }) {
  const [banks, setBanks] = useState<PayoutBank[] | null>(null);
  const [banksError, setBanksError] = useState<string | null>(null);
  const [bank, setBank] = useState<PayoutBank | null>(null);
  const [number, setNumber] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [verified, setVerified] = useState<VerifiedPayoutAccount | null>(null);
  const [busy, setBusy] = useState<'checking' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);

  const loadBanks = useCallback(async () => {
    setBanksError(null);
    try {
      setBanks(await listPayoutBanks(api));
    } catch (caught) {
      setBanksError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void loadBanks();
  }, [loadBanks]);

  // Any change to what was checked means it has to be checked again.
  const changeBank = (next: PayoutBank) => {
    setBank(next);
    setVerified(null);
    setError(null);
  };
  const changeNumber = (next: string) => {
    setNumber(next);
    setVerified(null);
    setError(null);
  };

  const numberProblem = accountNumberProblem(number);

  const check = async () => {
    setAttempted(true);
    if (working.current || !bank || numberProblem) return;
    working.current = true;
    setBusy('checking');
    setError(null);
    try {
      setVerified(await verifyPayoutAccount(api, { bankCode: bank.code, accountNumber: normaliseAccountNumber(number) }));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const save = async () => {
    if (working.current || !bank || !verified) return;
    working.current = true;
    setBusy('saving');
    setError(null);
    try {
      onSaved(await savePayoutAccount(api, { bankCode: bank.code, accountNumber: normaliseAccountNumber(number), accountName: verified.accountName }));
    } catch (caught) {
      setError(describeError(caught));
      // A changed name means the check is stale; ask for a fresh one.
      if (caught instanceof ApiError && caught.status === 409) setVerified(null);
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  return (
    <>
      <Card>
        <Text variant="label" weight="bold">{replacing ? 'Change bank account' : 'Add bank account'}</Text>
        {banksError ? (
          <>
            <Notice icon="alert-circle-outline" text={banksError} danger />
            <SecondaryButton label="Try again" onPress={() => void loadBanks()} />
          </>
        ) : (
          <BankPicker banks={banks} value={bank} onChange={changeBank} disabled={busy !== null} error={attempted && !bank ? 'Choose your bank.' : undefined} />
        )}
        <TextField
          label="Account number"
          value={number}
          onChangeText={changeNumber}
          placeholder="10 digits"
          keyboardType="number-pad"
          maxLength={13}
          editable={busy === null}
          error={attempted ? numberProblem : undefined}
          testID="bank-account-number"
        />
        {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
        {verified ? null : (
          <PrimaryCheckoutButton
            label={busy === 'checking' ? 'Checking with your bank…' : 'Check account'}
            onPress={() => void check()}
            disabled={busy !== null || !bank || numberProblem !== null}
            busy={busy === 'checking'}
          />
        )}
        <SecondaryButton label="Cancel" onPress={onCancel} disabled={busy !== null} />
      </Card>

      {verified ? (
        <Card>
          <Text variant="micro" tone="muted">Your bank says this account belongs to</Text>
          <Text variant="heading" testID="bank-account-name">{verified.accountName}</Text>
          <Text variant="caption" tone="muted">{verified.bankName} · {verified.accountNumberMasked}</Text>
          <Notice icon="information-outline" text="Save only if this is your name. DASH pays your earnings to this account." />
          <PrimaryCheckoutButton label={busy === 'saving' ? 'Saving…' : 'Save this account'} onPress={() => void save()} disabled={busy !== null} busy={busy === 'saving'} />
        </Card>
      ) : null}
    </>
  );
}

/** The provider's bank list, searchable, opening in place. */
function BankPicker({
  banks,
  value,
  onChange,
  disabled,
  error,
}: {
  banks: PayoutBank[] | null;
  value: PayoutBank | null;
  onChange: (bank: PayoutBank) => void;
  disabled: boolean;
  error?: string | undefined;
}) {
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => (banks ? filterBanks(banks, query) : []), [banks, query]);

  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label">Bank</Text>
      <Pressable
        onPress={() => !disabled && banks && setOpen((current) => !current)}
        accessibilityRole="button"
        accessibilityLabel={value ? `Bank, ${value.name}. Change` : 'Choose your bank'}
        accessibilityState={{ expanded: open, disabled: disabled || !banks }}
        testID="bank-picker"
        style={{ minHeight: 50, borderRadius: radius.md, borderWidth: error ? 1.5 : 1, borderColor: error ? palette.danger : open ? palette.accent : palette.edge, backgroundColor: palette.surface, paddingHorizontal: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
      >
        <Text variant="body" tone={value ? 'default' : 'subtle'} style={{ flex: 1 }}>{value?.name ?? (banks ? 'Choose your bank' : 'Loading banks…')}</Text>
        {banks ? <Icon name={open ? 'chevron-up' : 'chevron-down'} size={22} color={palette.textMuted} /> : <ActivityIndicator color={palette.accent} />}
      </Pressable>
      {open && banks ? (
        <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, overflow: 'hidden' }}>
          <View style={{ padding: space.sm }}>
            <TextField label="Search banks" value={query} onChangeText={setQuery} placeholder="e.g. Zenith, GTB, Opay" autoCorrect={false} autoCapitalize="none" />
          </View>
          <ScrollView style={{ maxHeight: 280 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {shown.length === 0 ? <Text variant="caption" tone="muted" style={{ padding: space.md }}>No bank matches “{query}”.</Text> : null}
            {shown.map((bank) => {
              const selected = bank.code === value?.code;
              return (
                <Pressable
                  key={bank.code}
                  onPress={() => {
                    onChange(bank);
                    setOpen(false);
                    setQuery('');
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={bank.name}
                  style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: space.md, flexDirection: 'row', alignItems: 'center', backgroundColor: pressed ? palette.sand : selected ? palette.accentSoft : 'transparent' })}
                >
                  <Text variant="body" weight={selected ? 'semibold' : 'regular'} style={{ flex: 1 }}>{bank.name}</Text>
                  {selected ? <Icon name="check" size={20} color={palette.accent} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {error ? <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">{error}</Text> : null}
    </View>
  );
}
