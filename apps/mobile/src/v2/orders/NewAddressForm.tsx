/**
 * Adding a delivery address, shared by checkout, Saved Addresses and the home
 * screen's delivery location.
 *
 * The coordinates matter: the server quotes a delivery fee from them, so an
 * address with no location cannot be priced. Checkout and Saved Addresses take
 * the phone's position at the moment of saving. The delivery-location screen
 * passes the position it already found, with the address it read there as the
 * starting text: the customer can correct the words, and the position stays
 * the one the phone reported.
 */

import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { api, ApiError } from '../../api';
import { createAddress } from '../../data/orders';
import { currentLocation } from '../../features/deviceLocation';
import { normalisePhone, PHONE_E164 } from '../../features/register';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Text } from '../../ui/Text';
import { Card, Notice, PrimaryCheckoutButton, SecondaryButton } from './parts';

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

export function NewAddressForm({
  defaultPhone,
  onSaved,
  onCancel,
  makeDefault = true,
  initialLine1 = '',
  position,
  title = 'Add a delivery address',
  saveLabel = 'Save address',
}: {
  defaultPhone: string;
  onSaved: (id: string) => Promise<void> | void;
  onCancel?: () => void;
  /** Whether the new address becomes the default. Checkout's always does. */
  makeDefault?: boolean;
  /** Starting text for the street address, e.g. a reverse-geocoded place. */
  initialLine1?: string;
  /** A position already found. Without one, saving takes a fresh fix. */
  position?: { latitude: number; longitude: number };
  title?: string;
  saveLabel?: string;
}) {
  const { palette } = useTheme();
  const [line1, setLine1] = useState(initialLine1);
  const [landmark, setLandmark] = useState('');
  const [phone, setPhone] = useState(defaultPhone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    const contactPhone = normalisePhone(phone);
    if (!PHONE_E164.test(contactPhone)) {
      setError('Enter the contact phone with the country code, e.g. +234…');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const found = position ? { ok: true as const, ...position } : await currentLocation();
      if (!found.ok) {
        setError(found.message);
        return;
      }
      const created = await createAddress(api, {
        line1: line1.trim(),
        landmark: landmark.trim() || undefined,
        contactPhone,
        latitude: found.latitude,
        longitude: found.longitude,
        isDefault: makeDefault,
      });
      await onSaved(created.id);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, onChange: (next: string) => void, placeholder: string, keyboard: 'default' | 'phone-pad' = 'default') => (
    <View style={{ gap: space.xs }}>
      <Text variant="micro" tone="muted">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.textSubtle}
        accessibilityLabel={label}
        keyboardType={keyboard}
        editable={!busy}
        style={{ minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: space.md, color: palette.text, fontFamily: 'Manrope_400Regular', fontSize: 14 }}
      />
    </View>
  );

  return (
    <Card>
      <Text variant="label" weight="bold">{title}</Text>
      {field('Street address', line1, setLine1, '12 Admiralty Way')}
      {field('Landmark (optional)', landmark, setLandmark, 'Near the second gate')}
      {field('Contact phone', phone, setPhone, '+234 803 000 0000', 'phone-pad')}
      <Notice
        icon="crosshairs-gps"
        text={
          position
            ? 'The map position is where your phone found you, and the delivery fee is quoted from it. Correct the address words if they are not quite right.'
            : "Saving uses your current location as this address's position, which is what the delivery fee is quoted from. Stand at the address when you save it."
        }
      />
      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      <PrimaryCheckoutButton label={busy ? 'Saving…' : saveLabel} onPress={() => void save()} disabled={busy || line1.trim().length < 3 || phone.trim().length === 0} busy={busy} />
      {onCancel ? <SecondaryButton label="Cancel" onPress={onCancel} disabled={busy} /> : null}
    </Card>
  );
}
