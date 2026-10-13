/**
 * Personal Details, for customers and riders: the person's name, phone and
 * where they are — the details sign-up collected — read from and saved to the
 * server, which holds the only copy.
 *
 * Email is how they sign in, so it is shown and not editable. A field the
 * server would not accept a change to (the phone while SMS sign-in is on) is
 * shown read-only rather than offered and then refused.
 */

import { NIGERIAN_STATES } from '@dash/domain/signup';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { api, ApiError } from '../../api';
import { getAccountProfile, savePhone, saveProfileFields } from '../../data/account';
import {
  formFromProfile,
  hasChanges,
  personalDetailsChanges,
  personalDetailsProblems,
  type AccountProfile,
  type PersonalDetailsField,
  type PersonalDetailsForm,
  type ProfileEditable,
} from '../../features/personalDetails';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { ErrorState } from '../../ui/Display';
import { TextField } from '../../ui/Fields';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton } from '../orders/parts';

const describeError = (error: unknown): string =>
  error instanceof ApiError
    ? error.isNetwork
      ? 'DASH could not be reached. Check your connection and try again.'
      : error.message
    : 'Something went wrong. Please try again.';

interface Loaded {
  profile: AccountProfile;
  editable: ProfileEditable;
}

export function PersonalDetailsScreen({ onBack }: { onBack: () => void }) {
  const { state: sessionState, refreshViewer } = useAppSession();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setLoaded(await getAccountProfile(api));
    } catch (caught) {
      setLoadError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    if (sessionState === 'authenticated') void load();
  }, [load, sessionState]);

  return (
    <OrderPage testID="personal-details-v2">
      <BackHeader title="Personal details" onBack={onBack} />
      {sessionState !== 'authenticated' ? (
        <Empty icon="account-lock-outline" title="Sign in to see your details" body="Your personal details belong to your DASH account." />
      ) : loadError ? (
        <ErrorState title="Couldn’t load your details" message={loadError} onRetry={() => void load()} />
      ) : !loaded ? (
        <View style={{ minHeight: 200, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator accessibilityLabel="Loading your details" />
        </View>
      ) : (
        <DetailsForm loaded={loaded} onSaved={async () => {
          await refreshViewer();
        }} />
      )}
    </OrderPage>
  );
}

function DetailsForm({ loaded, onSaved }: { loaded: Loaded; onSaved: () => Promise<void> }) {
  const { editable, profile } = loaded;
  const [initial, setInitial] = useState<PersonalDetailsForm>(() => formFromProfile(profile));
  const [form, setForm] = useState<PersonalDetailsForm>(initial);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverProblems, setServerProblems] = useState<Partial<Record<PersonalDetailsField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const savingRef = useRef(false);

  const changes = useMemo(() => personalDetailsChanges(initial, form, editable), [editable, form, initial]);
  const problems = useMemo(() => personalDetailsProblems(initial, form, editable), [editable, form, initial]);
  const shown = (field: PersonalDetailsField) => serverProblems[field] ?? (attempted ? problems[field] : undefined);

  const set = (field: PersonalDetailsField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setServerProblems((current) => ({ ...current, [field]: undefined }));
    setSavedNote(null);
  };

  const save = async () => {
    if (savingRef.current) return;
    setAttempted(true);
    if (Object.keys(problems).length > 0 || !hasChanges(changes)) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setSavedNote(null);
    // What the server holds once each request has answered.
    let saved: PersonalDetailsForm = initial;
    const savedFields: PersonalDetailsField[] = [];
    try {
      if (Object.keys(changes.profile).length > 0) {
        await saveProfileFields(api, changes.profile);
        saved = { ...saved, ...changes.profile };
        savedFields.push(...(Object.keys(changes.profile) as PersonalDetailsField[]));
      }
      if (changes.phone !== undefined) {
        try {
          await savePhone(api, changes.phone);
          saved = { ...saved, phone: changes.phone };
          savedFields.push('phone');
        } catch (caught) {
          // The other fields may already be saved; say exactly what was not.
          setServerProblems({
            phone: caught instanceof ApiError && caught.status === 400 ? 'Enter your phone number with the country code, e.g. +234…' : describeError(caught),
          });
          if (savedFields.length > 0) setSavedNote('Your other changes were saved.');
          return;
        }
      }
      setSavedNote('Your details are saved.');
      setAttempted(false);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      if (savedFields.length > 0) {
        const settled = saved;
        setInitial(settled);
        // Saved fields show their stored form (trimmed, phone without spaces).
        setForm((current) => {
          const next = { ...current };
          for (const field of savedFields) next[field] = settled[field];
          return next;
        });
        void onSaved();
      }
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <Card>
        <Text variant="label" weight="bold">Your details</Text>
        <TextField
          label="Full name"
          value={form.name}
          onChangeText={(value) => set('name', value)}
          placeholder="Adaeze Okonkwo"
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          maxLength={80}
          editable={!saving}
          error={shown('name')}
          testID="personal-details-name"
        />
        <ReadOnlyField label="Email" value={profile.email ?? 'Not set'} note="You sign in with this email, so it can’t be changed here." />
        {editable.phone ? (
          <TextField
            label="Phone"
            value={form.phone}
            onChangeText={(value) => set('phone', value)}
            placeholder="+234 801 234 5678"
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            editable={!saving}
            error={shown('phone')}
            hint={profile.phoneNotice ?? 'Used by riders to reach you about a delivery.'}
          />
        ) : (
          <ReadOnlyField label="Phone" value={profile.phone ?? 'Not set'} note="Phone numbers can’t be changed in the app right now. Contact DASH support if yours is wrong." />
        )}
      </Card>

      {editable.location ? (
        <Card>
          <Text variant="label" weight="bold">Where you are</Text>
          <StatePicker value={form.state} onChange={(value) => set('state', value)} error={shown('state')} disabled={saving} />
          <TextField
            label="City, town or area"
            value={form.cityArea}
            onChangeText={(value) => set('cityArea', value)}
            placeholder="Asaba"
            autoCapitalize="words"
            maxLength={80}
            editable={!saving}
            error={shown('cityArea')}
          />
        </Card>
      ) : null}

      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      {savedNote ? <Notice icon="check-circle-outline" text={savedNote} /> : null}

      <PrimaryCheckoutButton
        label={saving ? 'Saving…' : 'Save changes'}
        onPress={() => void save()}
        disabled={saving || !hasChanges(changes)}
        busy={saving}
      />
    </>
  );
}

function ReadOnlyField({ label, value, note }: { label: string; value: string; note: string }) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: space.xs }} accessible accessibilityLabel={`${label}, ${value}. ${note}`}>
      <Text variant="label">{label}</Text>
      <View style={{ minHeight: 50, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, paddingHorizontal: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text variant="body" tone="muted" style={{ flex: 1 }} selectable>{value}</Text>
        <Icon name="lock-outline" size={18} color={palette.textSubtle} />
      </View>
      <Text variant="caption" tone="muted">{note}</Text>
    </View>
  );
}

/**
 * The 37 states in a list that opens in place — no modal to dismiss, and it
 * scrolls inside the page on a small screen.
 */
function StatePicker({ value, onChange, error, disabled }: { value: string; onChange: (value: string) => void; error?: string | undefined; disabled: boolean }) {
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label">State</Text>
      <Pressable
        onPress={() => !disabled && setOpen((current) => !current)}
        accessibilityRole="button"
        accessibilityLabel={value ? `State, ${value}. Change` : 'Choose your state'}
        accessibilityState={{ expanded: open, disabled }}
        style={{ minHeight: 50, borderRadius: radius.md, borderWidth: error ? 1.5 : 1, borderColor: error ? palette.danger : open ? palette.accent : palette.edge, backgroundColor: palette.surface, paddingHorizontal: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
      >
        <Text variant="body" tone={value ? 'default' : 'subtle'} style={{ flex: 1 }}>{value || 'Choose your state'}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={22} color={palette.textMuted} />
      </Pressable>
      {open ? (
        <View style={{ maxHeight: 264, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, overflow: 'hidden' }}>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {NIGERIAN_STATES.map((state) => {
              const selected = state === value;
              return (
                <Pressable
                  key={state}
                  onPress={() => {
                    onChange(state);
                    setOpen(false);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={state}
                  style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: space.md, flexDirection: 'row', alignItems: 'center', backgroundColor: pressed ? palette.sand : selected ? palette.accentSoft : 'transparent' })}
                >
                  <Text variant="body" weight={selected ? 'semibold' : 'regular'} style={{ flex: 1 }}>{state}</Text>
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
