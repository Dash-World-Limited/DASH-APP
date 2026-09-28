/**
 * Terms of Service and Privacy Policy, as the server publishes them.
 *
 * The same versioned documents signup records acceptance of — never a copy
 * bundled into the app that could drift from what the person agreed to.
 */

import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { api } from '../../../src/api';
import { ApiError } from '../../../src/api/errors';
import { space } from '../../../src/theme/tokens';
import { AppBar, ErrorState, Screen, Skeleton, Text } from '../../../src/ui';

interface LegalDocument {
  title: string;
  version: string;
  body: string;
  effectiveFrom: string;
}

const ALLOWED = new Set(['terms-of-service', 'privacy-policy']);

export default function Legal() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [document, setDocument] = useState<LegalDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!slug || !ALLOWED.has(slug)) {
      setError('This document does not exist.');
      return;
    }
    try {
      const result = await api.request<{ document: LegalDocument }>(`/v1/legal/${slug}`, { auth: false });
      setDocument(result.document);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'This document could not load.');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      <AppBar title={document?.title ?? (slug === 'privacy-policy' ? 'Privacy Policy' : 'Terms of Service')} back />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.md }}>
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
        {!document && !error ? <Skeleton style={{ height: 300, borderRadius: 12 }} /> : null}
        {document ? (
          <>
            <Text variant="caption" tone="muted">
              Version {document.version} · effective {new Date(document.effectiveFrom).toLocaleDateString()}
            </Text>
            <Text variant="body" selectable>
              {document.body}
            </Text>
          </>
        ) : null}
      </View>
    </Screen>
  );
}
