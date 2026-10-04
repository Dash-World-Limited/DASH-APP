/**
 * Terms of Service and Privacy Policy, as the server publishes them.
 *
 * These are the same versioned documents signup records acceptance of. They
 * are fetched, never bundled: a copy compiled into the app would drift from
 * what the person actually agreed to, and the version and effective date
 * shown here have to be the ones on record.
 *
 * Google Play requires both to be reachable from inside the app, which is why
 * this screen exists at all rather than only as a website link.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { api, ApiError } from '../../api';
import { space } from '../../theme/tokens';
import { Text } from '../../ui/Text';
import { BackHeader, Empty, Notice, OrderPage } from '../orders/parts';

export type LegalSlug = 'terms-of-service' | 'privacy-policy';

interface LegalDocument {
  title: string;
  version: string;
  body: string;
  effectiveFrom: string;
}

const TITLES: Record<LegalSlug, string> = {
  'terms-of-service': 'Terms of Service',
  'privacy-policy': 'Privacy Policy',
};

export function isLegalSlug(value: string): value is LegalSlug {
  return value === 'terms-of-service' || value === 'privacy-policy';
}

export function LegalScreen({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [document, setDocument] = useState<LegalDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    if (!isLegalSlug(slug)) {
      setError('This document does not exist.');
      setBusy(false);
      return;
    }
    if (!api.configured) {
      setError('This build has no DASH API address, so the published documents cannot be fetched. They are available at dashworldng.com.');
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const result = await api.request<{ document: LegalDocument }>(`/v1/legal/${slug}`, { auth: false });
      setDocument(result.document);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'This document could not load.');
    } finally {
      setBusy(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const fallbackTitle = isLegalSlug(slug) ? TITLES[slug] : 'Legal';

  return (
    <OrderPage testID="legal-v2">
      <BackHeader title={document?.title ?? fallbackTitle} onBack={onBack} />
      {busy ? <View style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View> : null}
      {!busy && error ? <Empty icon="file-document-alert-outline" title={`${fallbackTitle} could not load`} body={error} action="Try again" onPress={() => void load()} /> : null}
      {document ? (
        <>
          <Notice icon="information-outline" text={`Version ${document.version} · effective ${new Date(document.effectiveFrom).toLocaleDateString()}`} />
          <Text variant="body" selectable style={{ paddingBottom: space.xl }}>{document.body}</Text>
        </>
      ) : null}
    </OrderPage>
  );
}
