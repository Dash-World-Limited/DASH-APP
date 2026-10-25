'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  CONTENT_TYPES,
  CONTENT_PLACEMENTS,
  contentSchema,
  type ContentInput,
} from '@dash/domain/content';
import { SERVICE_CATEGORIES } from '@dash/domain/services';
import { DashWordmark } from '@/components/brand/DashWordmark';
import { contentImageUrl } from '@/lib/content-media';
import { authedFetch, useMe } from '@/lib/session';
import './studio.css';

const BASE = '/v1/admin/content';
type Entry = {
  id: string;
  draft: ContentInput;
  version: number;
  publishedRevisionId: string | null;
  updatedAt: string;
  updatedBy: string;
};
type Revision = {
  id: string;
  number: number;
  action: string;
  payload: string;
  actorId: string;
  createdAt: string;
};
type Asset = {
  id: string;
  filename: string;
  title: string;
  alt: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
  uploadedBy: string;
  archivedAt: string | null;
  references: number;
  image: { url: string } | null;
};
type Dashboard = {
  drafts: number;
  published: number;
  media: number;
  recentlyUpdated: {
    id: string;
    draft: string;
    updatedAt: string;
    updatedBy: string;
  }[];
  recentlyPublished: Revision[];
};
const blank: ContentInput = {
  internalName: '',
  type: 'banner',
  placement: 'home.hero',
  title: '',
  body: '',
  mediaId: null,
  logoMediaId: null,
  vendorId: null,
  categoryId: null,
  href: null,
  label: '',
  featured: false,
  position: 0,
  visible: true,
  startsAt: null,
  endsAt: null,
};
const defaultPlacement: Record<
  ContentInput['type'],
  ContentInput['placement']
> = {
  banner: 'home.hero',
  promotion: 'home.promotions',
  announcement: 'home.announcements',
  featured_vendor: 'home.featured',
  vendor_presentation: 'vendor.presentation',
  category_artwork: 'category.artwork',
  collection: 'home.featured',
  faq: 'help',
  policy: 'legal',
  campaign: 'home.promotions',
};
const labelOf = (value: string) =>
  value.replaceAll('_', ' ').replaceAll('.', ' / ');
const dateOf = (value: string) => new Date(value).toLocaleString();
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed. Try again.';
}

export default function ContentStudio() {
  const { me, loaded } = useMe();
  const permitted = !!me?.permissions.includes('content:manage');
  const [tab, setTab] = useState<'overview' | 'content' | 'media'>('overview');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ContentInput>(blank);
  const [history, setHistory] = useState<Revision[]>([]);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [placement, setPlacement] = useState('');
  const [category, setCategory] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [vendorSearch, setVendorSearch] = useState('');
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadAlt, setUploadAlt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [confirm, setConfirm] = useState<'publish' | 'unpublish' | null>(null);

  async function refresh() {
    const [list, media, stats] = await Promise.all([
      authedFetch<{ entries: Entry[]; nextCursor: string | null }>(
        `${BASE}/entries`,
      ),
      authedFetch<{ assets: Asset[]; nextCursor: string | null }>(
        `${BASE}/media`,
      ),
      authedFetch<Dashboard>(`${BASE}/dashboard`),
    ]);
    const allEntries = [...list.entries];
    let cursor = list.nextCursor;
    while (cursor) {
      const next = await authedFetch<{
        entries: Entry[];
        nextCursor: string | null;
      }>(`${BASE}/entries?cursor=${cursor}`);
      allEntries.push(...next.entries);
      cursor = next.nextCursor;
    }
    const allAssets = [...media.assets];
    cursor = media.nextCursor;
    while (cursor) {
      const next = await authedFetch<{
        assets: Asset[];
        nextCursor: string | null;
      }>(`${BASE}/media?cursor=${cursor}`);
      allAssets.push(...next.assets);
      cursor = next.nextCursor;
    }
    setEntries(allEntries);
    setAssets(allAssets);
    setDashboard(stats);
  }
  useEffect(() => {
    if (permitted) void refresh().catch((e) => setError(messageOf(e)));
  }, [permitted]);
  useEffect(() => {
    if (!permitted) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void authedFetch<{ vendors: { id: string; name: string }[] }>(
        `${BASE}/vendors?search=${encodeURIComponent(vendorSearch)}`,
      )
        .then((result) => {
          if (!cancelled) setVendors(result.vendors);
        })
        .catch((e) => {
          if (!cancelled) setError(messageOf(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vendorSearch, permitted]);
  function update<K extends keyof ContentInput>(
    key: K,
    value: ContentInput[K],
  ) {
    setForm((old) => ({ ...old, [key]: value }));
    setPreview(false);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(item: Entry) {
    await run(async () => {
      const current = await authedFetch<Entry>(`${BASE}/entries/${item.id}`);
      const result = await authedFetch<{ revisions: Revision[] }>(
        `${BASE}/entries/${item.id}/history`,
      );
      setEntry(current);
      setForm(current.draft);
      setHistory(result.revisions);
      setEditing(true);
      setPreview(false);
      setConfirm(null);
      setTab('content');
    });
  }
  const dirty = !entry || JSON.stringify(form) !== JSON.stringify(entry.draft);
  async function save() {
    await run(async () => {
      const parsed = contentSchema.safeParse(form);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('\n'),
        );
      const result = entry
        ? await authedFetch<Entry>(`${BASE}/entries/${entry.id}`, {
            method: 'PUT',
            body: { version: entry.version, content: parsed.data },
          })
        : await authedFetch<Entry>(`${BASE}/entries`, {
            method: 'POST',
            body: parsed.data,
          });
      setEntry(result);
      setForm(result.draft);
      setHistory(
        (
          await authedFetch<{ revisions: Revision[] }>(
            `${BASE}/entries/${result.id}/history`,
          )
        ).revisions,
      );
      await refresh();
      setNotice('Draft saved. The live revision is unchanged.');
    });
  }
  async function publish(
    action: 'publish' | 'unpublish' | 'rollback',
    revisionId?: string,
  ) {
    if (!entry) return;
    await run(async () => {
      const result = await authedFetch<Entry>(
        `${BASE}/entries/${entry.id}/${action}`,
        {
          method: 'POST',
          body: {
            version: entry.version,
            ...(revisionId ? { revisionId } : {}),
          },
        },
      );
      setEntry(result);
      setForm(result.draft);
      setHistory(
        (
          await authedFetch<{ revisions: Revision[] }>(
            `${BASE}/entries/${result.id}/history`,
          )
        ).revisions,
      );
      setConfirm(null);
      setPreview(false);
      await refresh();
      setNotice(
        action === 'unpublish'
          ? 'Content taken offline.'
          : 'Live revision updated.',
      );
    });
  }
  async function upload() {
    if (!file) return;
    await run(async () => {
      if (file.size > 8 * 1024 * 1024)
        throw new Error('Choose an image under 8 MB.');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('Could not read image.'));
        reader.readAsDataURL(file);
      });
      await authedFetch(`${BASE}/media`, {
        method: 'POST',
        body: {
          filename: file.name,
          title: uploadTitle,
          alt: uploadAlt,
          contentType: file.type,
          data,
        },
      });
      await refresh();
      setNotice('Image uploaded. Select it in the content editor.');
    });
  }
  if (!loaded)
    return <main className="studio-gate">Loading staff session…</main>;
  if (!permitted || !me)
    return (
      <main className="studio-gate">
        <DashWordmark height="1.5rem" />
        <h1>DASH Content Studio</h1>
        <p>
          {me
            ? 'This account does not have content management access.'
            : 'Sign in with your existing staff account to continue.'}
        </p>
        <Link href="/admin/signin">Staff sign in</Link>
      </main>
    );
  const image = assets.find((asset) => asset.id === form.mediaId);
  const shown = entries.filter(
    (item) =>
      (!type || item.draft.type === type) &&
      (!placement || item.draft.placement === placement) &&
      (!category || item.draft.categoryId === category) &&
      (!vendorFilter || item.draft.vendorId === vendorFilter) &&
      (!status ||
        (status === 'published'
          ? !!item.publishedRevisionId
          : !item.publishedRevisionId)),
  );
  return (
    <div className="studio">
      <aside className="studio-sidebar">
        <DashWordmark height="1.3rem" />
        <p className="studio-eyebrow">CONTENT STUDIO</p>
        <nav aria-label="Content Studio">
          {(['overview', 'content', 'media'] as const).map((value) => (
            <button
              key={value}
              aria-current={tab === value ? 'page' : undefined}
              onClick={() => {
                setTab(value);
                setEditing(false);
              }}
            >
              {value === 'overview'
                ? 'Overview'
                : value === 'content'
                  ? 'Content & placements'
                  : 'Media library'}
            </button>
          ))}
        </nav>
        <div className="studio-identity">
          <p>{me.identity.displayName ?? me.identity.email}</p>
          <Link href="/admin">Operational console ↗</Link>
          <Link href="/home">View DASH APP ↗</Link>
        </div>
      </aside>
      <main id="main" className="studio-main">
        <header className="studio-header">
          <div>
            <p className="studio-eyebrow">DASH WORLD LIMITED / EDITORIAL</p>
            <h1>DASH Content Studio</h1>
            <p>Curate the details. Keep DASH unmistakable.</p>
          </div>
          <button
            className="studio-primary"
            disabled={busy}
            onClick={() => {
              setTab('content');
              setEntry(null);
              setForm(blank);
              setEditing(true);
              setHistory([]);
              setPreview(false);
              setConfirm(null);
            }}
          >
            + Create content
          </button>
        </header>
        {error && (
          <div className="studio-error" role="alert">
            {error}
            <button disabled={busy} onClick={() => void run(refresh)}>
              Reload content
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="studio-notice">
            {notice}
          </p>
        )}
        {tab === 'overview' && (
          <>
            <div className="studio-stats">
              {[
                ['Unpublished', dashboard?.drafts],
                ['Published', dashboard?.published],
                ['Media assets', dashboard?.media],
              ].map(([label, value]) => (
                <div key={label} className="studio-card">
                  <p>{label}</p>
                  <strong>{value ?? '—'}</strong>
                </div>
              ))}
            </div>
            <section className="studio-card">
              <p className="studio-eyebrow">YOUR WORKSPACE</p>
              <h2>Presentation, with purpose.</h2>
              <p>
                Prepare a draft, review the preview, then publish a named
                revision. Saved edits stay private until publication.
              </p>
              <div className="studio-quick">
                {[
                  ['Home & discovery', 'banner'],
                  ['Vendor presentation', 'vendor_presentation'],
                  ['Category artwork', 'category_artwork'],
                  ['Editorial & help', 'faq'],
                ].map(([label, kind]) => (
                  <button
                    key={kind}
                    onClick={() => {
                      setType(kind!);
                      setTab('content');
                    }}
                  >
                    {label} →
                  </button>
                ))}
              </div>
            </section>
            <div className="studio-columns">
              <section className="studio-card">
                <h2>Recently updated</h2>
                {dashboard?.recentlyUpdated.map((item) => (
                  <p key={item.id}>
                    <button
                      onClick={() => {
                        const found = entries.find((e) => e.id === item.id);
                        if (found) void open(found);
                      }}
                    >
                      {(JSON.parse(item.draft) as ContentInput).internalName}
                    </button>
                    <small>
                      {dateOf(item.updatedAt)} · {item.updatedBy}
                    </small>
                  </p>
                ))}
              </section>
              <section className="studio-card">
                <h2>Recently published</h2>
                {dashboard?.recentlyPublished.map((item) => (
                  <p key={item.id}>
                    {(JSON.parse(item.payload) as ContentInput).internalName}
                    <small>
                      Revision {item.number} · {dateOf(item.createdAt)}
                    </small>
                  </p>
                ))}
                {!dashboard?.recentlyPublished.length && (
                  <p>No publications yet.</p>
                )}
              </section>
            </div>
          </>
        )}
        {tab === 'content' && !editing && (
          <section className="studio-card">
            <h2>Content & placements</h2>
            <div className="studio-filters">
              <label>
                Type
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">All types</option>
                  {CONTENT_TYPES.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  <option value="draft">Unpublished</option>
                  <option value="published">Published</option>
                </select>
              </label>
              <label>
                Placement
                <select
                  value={placement}
                  onChange={(e) => setPlacement(e.target.value)}
                >
                  <option value="">All placements</option>
                  {CONTENT_PLACEMENTS.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Category
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">All categories</option>
                  {SERVICE_CATEGORIES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Vendor ID
                <input
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value)}
                  placeholder="Filter by vendor ID"
                />
              </label>
            </div>
            <div className="studio-table">
              <table>
                <thead>
                  <tr>
                    <th>Content</th>
                    <th>Placement</th>
                    <th>Live status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <button disabled={busy} onClick={() => void open(item)}>
                          {item.draft.internalName}
                        </button>
                        <small>{labelOf(item.draft.type)}</small>
                      </td>
                      <td>{item.draft.placement}</td>
                      <td>
                        <span
                          className={
                            item.publishedRevisionId
                              ? 'studio-pill'
                              : 'studio-pill draft'
                          }
                        >
                          {item.publishedRevisionId ? 'Published' : 'Draft'}
                        </span>
                      </td>
                      <td>{dateOf(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!shown.length && (
              <p className="studio-empty">
                No content here yet. Create a draft to get started.
              </p>
            )}
          </section>
        )}
        {tab === 'content' && editing && (
          <div className="studio-editor">
            <section className="studio-card">
              <div className="studio-row">
                <h2>{entry ? 'Edit content' : 'New draft'}</h2>
                <span className="studio-pill">
                  {entry?.publishedRevisionId
                    ? 'Live + working draft'
                    : 'Unpublished'}
                </span>
              </div>
              <p className="studio-muted">
                {entry
                  ? `Version ${entry.version} · Updated by ${entry.updatedBy}`
                  : 'Your first save creates a private draft.'}
              </p>
              <fieldset disabled={busy} className="studio-fields">
                <label>
                  Internal name
                  <input
                    value={form.internalName}
                    onChange={(e) => update('internalName', e.target.value)}
                    maxLength={120}
                  />
                </label>
                <div className="studio-columns">
                  <label>
                    Content type
                    <select
                      value={form.type}
                      onChange={(e) => {
                        const next = e.target.value as ContentInput['type'];
                        setForm((old) => ({
                          ...old,
                          type: next,
                          placement: defaultPlacement[next],
                        }));
                        setPreview(false);
                      }}
                    >
                      {CONTENT_TYPES.map((v) => (
                        <option key={v} value={v}>
                          {labelOf(v)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Placement
                    <select
                      value={form.placement}
                      onChange={(e) =>
                        update(
                          'placement',
                          e.target.value as ContentInput['placement'],
                        )
                      }
                    >
                      {CONTENT_PLACEMENTS.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Display title
                  <input
                    value={form.title}
                    onChange={(e) => update('title', e.target.value)}
                    maxLength={160}
                  />
                </label>
                <label>
                  Body / supporting copy
                  <textarea
                    rows={5}
                    value={form.body}
                    onChange={(e) => update('body', e.target.value)}
                    maxLength={5000}
                  />
                </label>
                <label>
                  Image / cover
                  <select
                    value={form.mediaId ?? ''}
                    onChange={(e) => update('mediaId', e.target.value || null)}
                  >
                    <option value="">No override</option>
                    {assets
                      .filter((a) => !a.archivedAt)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Logo / avatar override
                  <select
                    value={form.logoMediaId ?? ''}
                    onChange={(e) =>
                      update('logoMediaId', e.target.value || null)
                    }
                  >
                    <option value="">No override</option>
                    {assets
                      .filter((a) => !a.archivedAt)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Search vendors
                  <input
                    value={vendorSearch}
                    onChange={(e) => setVendorSearch(e.target.value)}
                    placeholder="Search by name"
                  />
                </label>
                <label>
                  Vendor
                  <select
                    value={form.vendorId ?? ''}
                    onChange={(e) => update('vendorId', e.target.value || null)}
                  >
                    <option value="">No vendor</option>
                    {form.vendorId &&
                      !vendors.some((v) => v.id === form.vendorId) && (
                        <option value={form.vendorId}>{form.vendorId}</option>
                      )}
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Service category
                  <select
                    value={form.categoryId ?? ''}
                    onChange={(e) =>
                      update(
                        'categoryId',
                        (e.target.value || null) as ContentInput['categoryId'],
                      )
                    }
                  >
                    <option value="">No category</option>
                    {SERVICE_CATEGORIES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  App destination
                  <select
                    value={form.href ?? ''}
                    onChange={(e) => update('href', e.target.value || null)}
                  >
                    <option value="">No link</option>
                    {[
                      '/home',
                      '/restaurants',
                      '/shops',
                      '/market',
                      '/pharmacy',
                      '/declutter',
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                    {form.href?.startsWith('/browse/') && (
                      <option>{form.href}</option>
                    )}
                  </select>
                </label>
                <div className="studio-columns">
                  <label>
                    Editorial label
                    <input
                      value={form.label}
                      maxLength={40}
                      onChange={(e) => update('label', e.target.value)}
                    />
                  </label>
                  <label>
                    Priority (lower first)
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      value={form.position}
                      onChange={(e) =>
                        update('position', Number(e.target.value))
                      }
                    />
                  </label>
                </div>
                <div className="studio-columns">
                  <label>
                    Starts at (UTC)
                    <input
                      type="datetime-local"
                      value={form.startsAt?.slice(0, 16) ?? ''}
                      onChange={(e) =>
                        update(
                          'startsAt',
                          e.target.value
                            ? new Date(`${e.target.value}:00Z`).toISOString()
                            : null,
                        )
                      }
                    />
                  </label>
                  <label>
                    Ends at (UTC)
                    <input
                      type="datetime-local"
                      value={form.endsAt?.slice(0, 16) ?? ''}
                      onChange={(e) =>
                        update(
                          'endsAt',
                          e.target.value
                            ? new Date(`${e.target.value}:00Z`).toISOString()
                            : null,
                        )
                      }
                    />
                  </label>
                </div>
                <label className="studio-check">
                  <input
                    type="checkbox"
                    checked={form.visible}
                    onChange={(e) => update('visible', e.target.checked)}
                  />{' '}
                  Visible when published and in schedule
                </label>
                <label className="studio-check">
                  <input
                    type="checkbox"
                    checked={form.featured}
                    onChange={(e) => update('featured', e.target.checked)}
                  />{' '}
                  Featured presentation
                </label>
              </fieldset>
              <div className="studio-actions">
                <button disabled={busy} onClick={() => void save()}>
                  Save draft
                </button>
                <button disabled={busy} onClick={() => setPreview(true)}>
                  Preview
                </button>
                <button
                  className="studio-primary"
                  disabled={busy || !entry || dirty || !preview}
                  onClick={() => setConfirm('publish')}
                >
                  Publish…
                </button>
                {entry?.publishedRevisionId && (
                  <button
                    disabled={busy || dirty}
                    onClick={() => setConfirm('unpublish')}
                  >
                    Unpublish…
                  </button>
                )}
              </div>
              <p className="studio-muted">
                Save and preview your draft to enable publication.
              </p>
              {confirm && (
                <div role="alert" className="studio-confirm">
                  <p>
                    {confirm === 'publish'
                      ? 'Make this saved revision available to DASH APP clients?'
                      : 'Remove this content from the published feed?'}
                  </p>
                  <button disabled={busy} onClick={() => void publish(confirm)}>
                    Confirm {confirm}
                  </button>
                  <button onClick={() => setConfirm(null)}>Keep editing</button>
                </div>
              )}
            </section>
            <div>
              <section className="studio-card">
                <p className="studio-eyebrow">EDITORIAL PREVIEW</p>
                <h2>
                  {preview
                    ? 'Your next presentation'
                    : 'Review before publishing'}
                </h2>
                {preview ? (
                  <article className="studio-preview">
                    {image?.image && (
                      <img
                        src={contentImageUrl(image.image.url) ?? undefined}
                        alt={image.alt}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    )}
                    <div>
                      {form.label && (
                        <span className="studio-pill">{form.label}</span>
                      )}
                      <h3>{form.title || 'Untitled'}</h3>
                      <p>{form.body}</p>
                      {form.href && <span>Destination: {form.href}</span>}
                    </div>
                  </article>
                ) : (
                  <p>
                    Preview shows the current form. Save it before publishing.
                    Plain text is rendered as text.
                  </p>
                )}
                <p className="studio-muted">
                  {form.placement} · {form.visible ? 'Visible' : 'Hidden'} ·
                  Priority {form.position}
                </p>
                <p className="studio-muted">
                  Live revision: {entry?.publishedRevisionId ?? 'None'}
                </p>
              </section>
              <section className="studio-card">
                <h2>Revision history</h2>
                {history.map((r) => (
                  <div className="studio-history" key={r.id}>
                    <strong>
                      #{r.number} · {r.action}
                    </strong>
                    <small>
                      {dateOf(r.createdAt)}
                      <br />
                      By {r.actorId}
                    </small>
                    {['publish', 'rollback'].includes(r.action) &&
                      r.id !== entry?.publishedRevisionId && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => void publish('rollback', r.id)}
                        >
                          Restore this publication
                        </button>
                      )}
                  </div>
                ))}
                {history.length > 0 && history.length % 50 === 0 && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const more = await authedFetch<{
                          revisions: Revision[];
                        }>(
                          `${BASE}/entries/${entry!.id}/history?before=${history.at(-1)!.number}`,
                        );
                        setHistory([...history, ...more.revisions]);
                      })
                    }
                  >
                    Load older revisions
                  </button>
                )}
                {!history.length && <p>History starts with your first save.</p>}
              </section>
            </div>
          </div>
        )}
        {tab === 'media' && (
          <>
            <section className="studio-card">
              <p className="studio-eyebrow">DASH-CURATED ASSETS</p>
              <h2>Media library</h2>
              <p>
                JPEG, PNG or WebP · up to 8 MB · still images only. Assets are
                retained when referenced by any saved revision.
              </p>
              <fieldset disabled={busy} className="studio-upload">
                <label>
                  Image
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <label>
                  Title
                  <input
                    value={uploadTitle}
                    onChange={(e) => setUploadTitle(e.target.value)}
                    maxLength={120}
                  />
                </label>
                <label>
                  Alt text
                  <input
                    value={uploadAlt}
                    onChange={(e) => setUploadAlt(e.target.value)}
                    maxLength={300}
                  />
                </label>
                <button
                  className="studio-primary"
                  disabled={!file || !uploadTitle.trim() || !uploadAlt.trim()}
                  onClick={() => void upload()}
                >
                  Upload image
                </button>
              </fieldset>
            </section>
            <div className="studio-media-grid">
              {assets.map((a) => (
                <article key={a.id} className="studio-card">
                  {a.image && (
                    <img
                      src={contentImageUrl(a.image.url) ?? undefined}
                      alt={a.alt}
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                  <h3>{a.title}</h3>
                  <p>{a.alt}</p>
                  <small>
                    {a.filename}
                    <br />
                    {a.width} × {a.height} · {Math.ceil(a.bytes / 1024)} KB
                    <br />
                    Uploaded {dateOf(a.createdAt)}
                    <br />
                    By {a.uploadedBy}
                    <br />
                    {a.references} revision references
                  </small>
                  <button
                    disabled={busy || !!a.archivedAt || a.references > 0}
                    onClick={() =>
                      void run(async () => {
                        await authedFetch(`${BASE}/media/${a.id}/archive`, {
                          method: 'POST',
                        });
                        await refresh();
                      })
                    }
                  >
                    {a.archivedAt ? 'Archived' : 'Archive'}
                  </button>
                </article>
              ))}
            </div>
            {!assets.length && (
              <p className="studio-empty">
                Your library is ready for its first image.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
