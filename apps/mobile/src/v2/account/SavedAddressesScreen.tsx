/**
 * Saved Addresses: the customer's delivery addresses, with the default one
 * first — the one checkout picks for them.
 *
 * Add uses checkout's own form, which stamps the phone's position at the
 * moment of saving. Edit changes the words (label, street, landmark,
 * instructions, contact phone), never the position the fee is quoted from.
 * Remove takes an address off the list; orders already sent there keep it.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';

import { api, ApiError } from '../../api';
import { listAddresses, removeAddress, updateAddress, type Address, type AddressEdit } from '../../data/orders';
import { normalisePhone, PHONE_E164 } from '../../features/register';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { ErrorState } from '../../ui/Display';
import { TextField } from '../../ui/Fields';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { NewAddressForm } from '../orders/NewAddressForm';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from '../orders/parts';

const describeError = (error: unknown): string =>
  error instanceof ApiError
    ? error.isNetwork
      ? 'DASH could not be reached. Check your connection and try again.'
      : error.message
    : 'Something went wrong. Please try again.';

export function SavedAddressesScreen({ onBack }: { onBack: () => void }) {
  const { state: sessionState, viewer } = useAppSession();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setAddresses(await listAddresses(api));
    } catch (caught) {
      setLoadError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    if (sessionState === 'authenticated') void load();
  }, [load, sessionState]);

  const act = async (id: string, run: () => Promise<void>, done: string) => {
    if (busyId) return;
    setBusyId(id);
    setActionError(null);
    setNote(null);
    try {
      await run();
      await load();
      setNote(done);
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = (address: Address) => {
    Alert.alert(
      'Remove this address?',
      'It will no longer appear at checkout. Orders already delivered there are not affected.',
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void act(address.id, () => removeAddress(api, address.id), 'Address removed.') },
      ],
    );
  };

  if (sessionState !== 'authenticated') {
    return (
      <OrderPage testID="saved-addresses-v2">
        <BackHeader title="Saved addresses" onBack={onBack} />
        <Empty icon="account-lock-outline" title="Sign in to see your addresses" body="Saved addresses belong to your DASH account." />
      </OrderPage>
    );
  }

  return (
    <OrderPage testID="saved-addresses-v2">
      <BackHeader title="Saved addresses" onBack={onBack} />

      {loadError ? (
        <ErrorState title="Couldn’t load your addresses" message={loadError} onRetry={() => void load()} />
      ) : addresses === null ? (
        <View style={{ minHeight: 200, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator accessibilityLabel="Loading your addresses" />
        </View>
      ) : (
        <>
          {addresses.length === 0 && !adding ? (
            <Empty
              icon="map-marker-plus-outline"
              title="No saved addresses yet"
              body="Add the places you order to most, like home or work. Your default address is chosen first at checkout."
              action="Add an address"
              onPress={() => setAdding(true)}
            />
          ) : null}

          {addresses.map((address) =>
            editingId === address.id ? (
              <EditAddressForm
                key={address.id}
                address={address}
                onCancel={() => setEditingId(null)}
                onSaved={async () => {
                  setEditingId(null);
                  await load();
                  setNote('Address updated.');
                }}
              />
            ) : (
              <AddressCard
                key={address.id}
                address={address}
                busy={busyId === address.id}
                disabled={Boolean(busyId) || adding || editingId !== null}
                onMakeDefault={() => void act(address.id, () => updateAddress(api, address.id, { isDefault: true }), 'Default address updated.')}
                onEdit={() => {
                  setNote(null);
                  setActionError(null);
                  setEditingId(address.id);
                }}
                onRemove={() => confirmRemove(address)}
              />
            ),
          )}

          {actionError ? <Notice icon="alert-circle-outline" text={actionError} danger /> : null}
          {note ? <Notice icon="check-circle-outline" text={note} /> : null}

          {adding ? (
            <NewAddressForm
              defaultPhone={viewer?.identity.phone ?? ''}
              makeDefault={addresses.length === 0}
              onSaved={async () => {
                setAdding(false);
                await load();
                setNote('Address saved.');
              }}
              onCancel={() => setAdding(false)}
            />
          ) : addresses.length > 0 && editingId === null ? (
            <SecondaryButton label="Add a new address" onPress={() => { setNote(null); setAdding(true); }} disabled={Boolean(busyId)} />
          ) : null}
        </>
      )}
    </OrderPage>
  );
}

function AddressCard({
  address,
  busy,
  disabled,
  onMakeDefault,
  onEdit,
  onRemove,
}: {
  address: Address;
  busy: boolean;
  disabled: boolean;
  onMakeDefault: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { palette } = useTheme();
  const title = address.label ?? 'Saved address';
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
        <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={iconFor(address.label)} color={palette.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
            <Text variant="bodyStrong">{title}</Text>
            {address.isDefault ? (
              <View style={{ paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: palette.successSoft }}>
                <Text variant="micro" weight="bold" tone="success">Default</Text>
              </View>
            ) : null}
          </View>
          <Text variant="body">{address.line1}</Text>
          {address.landmark ? <Text variant="caption" tone="muted">{address.landmark}</Text> : null}
          {address.instructions ? <Text variant="caption" tone="muted">{address.instructions}</Text> : null}
          <Text variant="caption" tone="muted">Contact {address.contactPhone}</Text>
        </View>
        {busy ? <ActivityIndicator color={palette.accent} /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginLeft: -space.sm }}>
        {!address.isDefault ? <TextAction icon="star-outline" label="Make default" onPress={onMakeDefault} disabled={disabled} /> : null}
        <TextAction icon="pencil-outline" label="Edit" onPress={onEdit} disabled={disabled} />
        <TextAction icon="trash-can-outline" label="Remove" onPress={onRemove} disabled={disabled} danger />
      </View>
    </Card>
  );
}

function iconFor(label: string | null): IconName {
  const value = (label ?? '').trim().toLowerCase();
  if (value === 'home') return 'home-outline';
  if (value === 'work' || value === 'office') return 'briefcase-outline';
  return 'map-marker-outline';
}

function TextAction({ icon, label, onPress, disabled, danger = false }: { icon: IconName; label: string; onPress: () => void; disabled: boolean; danger?: boolean }) {
  const { palette } = useTheme();
  const color = danger ? palette.danger : palette.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({ minHeight: touchTarget, paddingHorizontal: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.sm, opacity: disabled ? 0.45 : pressed ? 0.6 : 1 })}
    >
      <Icon name={icon} size={18} color={color} />
      <Text variant="caption" weight="bold" style={{ color }}>{label}</Text>
    </Pressable>
  );
}

function EditAddressForm({ address, onCancel, onSaved }: { address: Address; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [label, setLabel] = useState(address.label ?? '');
  const [line1, setLine1] = useState(address.line1);
  const [landmark, setLandmark] = useState(address.landmark ?? '');
  const [instructions, setInstructions] = useState(address.instructions ?? '');
  const [phone, setPhone] = useState(address.contactPhone);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = {
    line1: line1.trim().length < 3 ? 'Enter the street address' : undefined,
    phone: PHONE_E164.test(normalisePhone(phone)) ? undefined : 'Enter the contact phone with the country code, e.g. +234…',
  };

  const edit: AddressEdit = {};
  if (label.trim() !== (address.label ?? '')) edit.label = label.trim();
  if (line1.trim() !== address.line1) edit.line1 = line1.trim();
  if (landmark.trim() !== (address.landmark ?? '')) edit.landmark = landmark.trim();
  if (instructions.trim() !== (address.instructions ?? '')) edit.instructions = instructions.trim();
  if (normalisePhone(phone) !== address.contactPhone) edit.contactPhone = normalisePhone(phone);
  const changed = Object.keys(edit).length > 0;

  const save = async () => {
    if (busy) return;
    setAttempted(true);
    if (problems.line1 || problems.phone || !changed) return;
    setBusy(true);
    setError(null);
    try {
      await updateAddress(api, address.id, edit);
      await onSaved();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text variant="label" weight="bold">Edit address</Text>
      <TextField label="Label (optional)" value={label} onChangeText={setLabel} placeholder="Home, Work…" autoCapitalize="words" maxLength={40} editable={!busy} />
      <TextField label="Street address" value={line1} onChangeText={setLine1} placeholder="12 Admiralty Way" maxLength={200} editable={!busy} error={attempted ? problems.line1 : undefined} />
      <TextField label="Landmark (optional)" value={landmark} onChangeText={setLandmark} placeholder="Near the second gate" maxLength={120} editable={!busy} />
      <TextField label="Delivery instructions (optional)" value={instructions} onChangeText={setInstructions} placeholder="Gate colour, who to call…" maxLength={280} editable={!busy} />
      <TextField label="Contact phone" value={phone} onChangeText={setPhone} placeholder="+234 803 000 0000" keyboardType="phone-pad" autoComplete="tel" editable={!busy} error={attempted ? problems.phone : undefined} />
      <Notice icon="map-marker-outline" text="The map position stays where this address was saved. If the address itself has moved, add it again and remove this one." />
      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      <PrimaryCheckoutButton label={busy ? 'Saving…' : 'Save address'} onPress={() => void save()} disabled={busy || !changed} busy={busy} />
      <SecondaryButton label="Cancel" onPress={onCancel} disabled={busy} />
    </Card>
  );
}
