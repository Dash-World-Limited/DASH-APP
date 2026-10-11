'use client';

import { useEffect, useMemo, useState } from 'react';

import { ApiRequestError } from '@/lib/api';
import { authedFetch } from '@/lib/session';

type PhotoRole = 'front' | 'back' | 'side' | 'label' | 'screen' | 'accessories' | 'damage' | 'other';

interface Taxonomy {
  categories: Array<{ key: string; name: string; slug: string }>;
  locations: Array<{ slug: string; label: string }>;
}

interface Submission {
  id: string;
  code: string;
  status: string;
  title: string | null;
}

interface SelectedPhoto {
  file: File;
  role: PhotoRole;
}

const PHOTO_ROLES: Array<{ value: PhotoRole; label: string }> = [
  { value: 'front', label: 'Front view' },
  { value: 'back', label: 'Back view' },
  { value: 'side', label: 'Side view' },
  { value: 'label', label: 'Model / label' },
  { value: 'screen', label: 'Screen / display' },
  { value: 'accessories', label: 'Accessories' },
  { value: 'damage', label: 'Damage / defect' },
  { value: 'other', label: 'Other useful view' },
];

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 12;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      if (comma < 0) reject(new Error('Could not read that image.'));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function messageOf(caught: unknown): string {
  return caught instanceof ApiRequestError
    ? caught.message
    : caught instanceof Error
      ? caught.message
      : 'Something went wrong. Please try again.';
}

export function ItemSubmissionForm({ kycStatus }: { kycStatus: string }) {
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryKey, setCategoryKey] = useState('');
  const [locationSlug, setLocationSlug] = useState('');
  const [condition, setCondition] = useState<'new' | 'like_new' | 'good' | 'fair'>('good');
  const [expectedPrice, setExpectedPrice] = useState('');
  const [preAuthorizePrice, setPreAuthorizePrice] = useState(false);
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Submission | null>(null);
  const [notified, setNotified] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authedFetch<Taxonomy>('/v1/declutter/taxonomy')
      .then((value) => {
        if (cancelled) return;
        setTaxonomy(value);
        setCategoryKey((current) => current || value.categories[0]?.key || '');
        setLocationSlug((current) => current || value.locations[0]?.slug || '');
      })
      .catch((caught) => {
        if (!cancelled) setError(messageOf(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = useMemo(
    () =>
      !busy &&
      title.trim().length >= 3 &&
      description.trim().length >= 10 &&
      Boolean(categoryKey) &&
      Boolean(locationSlug) &&
      photos.length > 0,
    [busy, categoryKey, description, locationSlug, photos.length, title],
  );

  function choosePhotos(files: FileList | null) {
    if (!files) return;
    setError(null);

    const incoming = Array.from(files);
    if (photos.length + incoming.length > MAX_PHOTOS) {
      setError(`You can upload up to ${MAX_PHOTOS} photos for one item.`);
      return;
    }

    for (const file of incoming) {
      if (!ACCEPTED_TYPES.has(file.type)) {
        setError('Use JPEG, PNG or WebP images only.');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is larger than 8 MB.`);
        return;
      }
    }

    setPhotos((current) => [
      ...current,
      ...incoming.map((file, index) => ({
        file,
        role: current.length === 0 && index === 0 ? ('front' as const) : ('other' as const),
      })),
    ]);
  }

  function reset() {
    setTitle('');
    setDescription('');
    setExpectedPrice('');
    setPreAuthorizePrice(false);
    setCondition('good');
    setPhotos([]);
    setCreated(null);
    setProgress('');
    setError(null);
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setProgress('Creating your item…');

    try {
      const parsedNaira = expectedPrice.trim() ? Number(expectedPrice.replace(/,/g, '')) : null;
      if (parsedNaira !== null && (!Number.isFinite(parsedNaira) || parsedNaira <= 0)) {
        throw new Error('Enter a valid expected price or leave it blank.');
      }
      if (preAuthorizePrice && parsedNaira === null) throw new Error('Enter a price before pre-authorising it.');

      const response = await authedFetch<{ submission: Submission }>('/v1/declutter/submissions', {
        method: 'POST',
        body: {
          title: title.trim(),
          description: description.trim(),
          categoryKey,
          condition,
          locationSlug,
          ...(parsedNaira !== null ? { expectedPriceKobo: Math.round(parsedNaira * 100) } : {}),
          preAuthorizePrice,
        },
      });

      for (let index = 0; index < photos.length; index += 1) {
        const selected = photos[index]!;
        setProgress(`Uploading photo ${index + 1} of ${photos.length}…`);
        const data = await fileToBase64(selected.file);
        await authedFetch(`/v1/declutter/submissions/${response.submission.id}/photos`, {
          method: 'POST',
          body: {
            contentType: selected.file.type,
            role: selected.role,
            data,
          },
        });
      }

      // This is the notification boundary. The API refuses to complete an item
      // with no photos, and sends the seller/admin emails idempotently here.
      setProgress('Finishing your submission…');
      const completion = await authedFetch<{ notified: boolean }>(`/v1/declutter/submissions/${response.submission.id}/complete`, {
        method: 'POST',
      });

      setNotified(completion.notified);
      setCreated(response.submission);
      setProgress('');
    } catch (caught) {
      setError(messageOf(caught));
      setProgress('');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="dcl-glass rounded-[var(--radius-card)] p-6">
        <p className="dcl-eyebrow">Item received</p>
        <h2 className="mt-3 text-xl font-bold">{created.title ?? title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
          Reference <strong>{created.code}</strong>. Your photos are uploaded and the item is now in
          the DASH review flow. {notified ? 'Your confirmation email has been accepted for delivery.' : 'Email confirmation is pending; your item is safely submitted.'}
        </p>
        <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface-sunken)] p-4 text-sm text-[var(--ink-muted)]">
          {kycStatus === 'verified'
            ? 'Once DASH reviews the item, authorises the fixed price and you accept it, the listing can be published. Published listings appear automatically on the Declutters website and in DASH APP.'
            : 'You can submit items before verification is finished. DASH will not publish them until your seller verification and item review are complete.'}
        </div>
        <button
          type="button"
          onClick={reset}
          className="mt-6 min-h-12 w-full rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)]"
        >
          Add another item
        </button>
      </div>
    );
  }

  return (
    <div className="dcl-glass rounded-[var(--radius-card)] p-6">
      <p className="dcl-eyebrow">List an item</p>
      <h2 className="mt-2 text-xl font-bold">Show DASH what you want to sell</h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
        Add honest details and photographs of the actual item. Nothing becomes public until DASH
        reviews it.
      </p>

      {kycStatus !== 'verified' ? (
        <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface-sunken)] p-4 text-xs leading-relaxed text-[var(--ink-muted)]">
          Seller verification is still <strong>{kycStatus.replaceAll('_', ' ')}</strong>. You can
          upload items now; publication stays locked until verification is complete.
        </div>
      ) : null}

      <div className="mt-6 space-y-4">
        <label className="block text-sm font-semibold">
          Item title
          <input
            value={title}
            maxLength={140}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Samsung Galaxy S23 Ultra 256GB"
            className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm outline-none focus:border-[var(--primary)]"
          />
        </label>

        <label className="block text-sm font-semibold">
          Description
          <textarea
            value={description}
            maxLength={4000}
            rows={4}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Condition, age, what works, what does not, accessories included…"
            className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 py-3 text-sm outline-none focus:border-[var(--primary)]"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold">
            Category
            <select
              value={categoryKey}
              onChange={(event) => setCategoryKey(event.target.value)}
              className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm outline-none focus:border-[var(--primary)]"
            >
              {(taxonomy?.categories ?? []).map((category) => (
                <option key={category.key} value={category.key}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-semibold">
            Condition
            <select
              value={condition}
              onChange={(event) => setCondition(event.target.value as typeof condition)}
              className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm outline-none focus:border-[var(--primary)]"
            >
              <option value="new">New</option>
              <option value="like_new">Like new</option>
              <option value="good">Good</option>
              <option value="fair">Fair</option>
            </select>
          </label>

          <label className="block text-sm font-semibold">
            Area
            <select
              value={locationSlug}
              onChange={(event) => setLocationSlug(event.target.value)}
              className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm outline-none focus:border-[var(--primary)]"
            >
              {(taxonomy?.locations ?? []).map((location) => (
                <option key={location.slug} value={location.slug}>
                  {location.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-semibold">
            Price you have in mind <span className="font-normal text-[var(--ink-muted)]">(optional)</span>
            <div className="relative mt-2">
              <span className="pointer-events-none absolute left-4 top-3 text-sm text-[var(--ink-muted)]">₦</span>
              <input
                value={expectedPrice}
                inputMode="numeric"
                onChange={(event) => { setExpectedPrice(event.target.value.replace(/[^0-9,]/g, '')); setPreAuthorizePrice(false); }}
                placeholder="250,000"
                className="min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] pl-9 pr-4 text-sm outline-none focus:border-[var(--primary)]"
              />
            </div>
          </label>
        </div>
      </div>

      <label className="mt-5 flex items-start gap-3 rounded-xl border border-[var(--line)] p-4 text-sm leading-relaxed">
        <input type="checkbox" checked={preAuthorizePrice} disabled={busy || !expectedPrice.trim() || Number(expectedPrice.replace(/,/g, '')) <= 0}
          onChange={event => setPreAuthorizePrice(event.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[var(--primary)]" />
        <span>I pre-authorise my submitted price if DASH's first price approval is for that exact amount.
          <span className="mt-1 block text-xs text-[var(--ink-muted)]">Optional. DASH must still review and authorise the price. If it changes, or you leave this unchecked, we will ask you to accept it before publication.</span>
        </span>
      </label>

      <div className="mt-7 border-t border-[var(--line)] pt-6">
        <p className="text-sm font-bold">Photographs</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
          Upload the actual item, not catalogue photos. Add clear views of defects, labels and accessories.
        </p>
        <label className="mt-4 block cursor-pointer rounded-2xl border border-dashed border-[var(--line-strong)] p-5 text-center transition-colors hover:bg-[var(--surface-sunken)]">
          <span className="text-sm font-bold">Choose photos</span>
          <span className="mt-1 block text-xs text-[var(--ink-muted)]">JPEG, PNG or WebP · up to {MAX_PHOTOS} photos · 8 MB each</span>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(event) => choosePhotos(event.target.files)}
          />
        </label>

        {photos.length > 0 ? (
          <div className="mt-4 space-y-3">
            {photos.map((selected, index) => (
              <div key={`${selected.file.name}-${index}`} className="rounded-xl border border-[var(--line)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold">{selected.file.name}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--ink-muted)]">{Math.max(1, Math.round(selected.file.size / 1024))} KB</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    className="text-xs font-bold text-[var(--danger)]"
                  >
                    Remove
                  </button>
                </div>
                <label className="mt-3 block text-xs font-semibold">
                  What does this photo show?
                  <select
                    value={selected.role}
                    onChange={(event) =>
                      setPhotos((current) =>
                        current.map((photo, itemIndex) =>
                          itemIndex === index
                            ? { ...photo, role: event.target.value as PhotoRole }
                            : photo,
                        ),
                      )
                    }
                    className="mt-1.5 min-h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] px-3 text-xs"
                  >
                    {PHOTO_ROLES.map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-5 text-sm font-semibold text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {progress ? <p className="mt-5 text-center text-xs font-semibold text-[var(--ink-muted)]">{progress}</p> : null}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="mt-5 min-h-12 w-full rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
      >
        {busy ? 'Submitting…' : 'Submit item to DASH'}
      </button>
    </div>
  );
}
