import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import { verifyPassword } from '@dash/domain/crypto';
import { assertContentEditorStagingTarget, provisionContentEditor } from '../staff/provision-content-editor.js';
import { createTestContext, findCookie, signInWithPassword, type TestContext } from './harness.js';
import { CSRF_COOKIE, REFRESH_COOKIE } from '../auth/cookies.js';

const BASE = '/v1/admin/content';
const email = 'studio-editor@dashapp.test';
const password = 'EditorFixtureOnly!2026';
const draft = { internalName: 'Editor draft', type: 'announcement', placement: 'home.announcements', title: 'Private draft' };
const totp = new TOTP({ crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin(), algorithm: 'sha1', digits: 6, period: 30 });
let ctx: TestContext;
let identityId: string;
let editorHeaders: Record<string, string>;
let adminHeaders: Record<string, string>;
let firstLogin: Record<string, unknown>;
let recoveryCodes: string[];
let firstCookies: unknown;
const headersFor = (session: { accessToken: string; csrfToken: string }) => ({
  authorization: `Bearer ${session.accessToken}`, 'x-csrf-token': session.csrfToken, cookie: `${CSRF_COOKIE}=${session.csrfToken}`,
});
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = editorHeaders) =>
  ctx.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.prisma.identityRole.updateMany({ where: { identityId: ctx.identityId }, data: { role: 'super_admin' } });
  identityId = (await provisionContentEditor(ctx.prisma, { email, displayName: 'Studio employee', password })).id;
  const login = await call('POST', '/v1/auth/login', { email, password }, {});
  firstLogin = login.json();
  firstCookies = findCookie(login.headers['set-cookie'], REFRESH_COOKIE);
  const start = await call('POST', '/v1/auth/mfa/enrol/start', { challengeToken: firstLogin.challengeToken }, {});
  const confirmed = await call('POST', '/v1/auth/mfa/enrol/confirm', {
    challengeToken: firstLogin.challengeToken, code: await totp.generate({ secret: start.json<{ secret: string }>().secret }),
  }, {});
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const enrolled = confirmed.json<{ accessToken: string; csrfToken: string; recoveryCodes: string[] }>();
  recoveryCodes = enrolled.recoveryCodes;
  editorHeaders = headersFor(enrolled);
  adminHeaders = headersFor(await signInWithPassword(ctx));
});
afterAll(async () => { await ctx?.close(); });

describe('Studio employee identity and privileges', () => {
  it('provisions exactly the editor role with the existing password hash and a secret-free audit', async () => {
    const identity = await ctx.prisma.identity.findUniqueOrThrow({ where: { id: identityId }, include: { roles: true } });
    expect(identity.roles.map(r => r.role)).toEqual(['content_editor']);
    expect(identity.passwordHash).toMatch(/^s1\$/);
    expect(await verifyPassword(password, identity.passwordHash!)).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { resourceId: identityId, action: 'staff.content_editor.provision' } })).toBe(1);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { resourceId: identityId, action: 'staff.content_editor.provision' } });
    expect(JSON.stringify(audit)).not.toContain(password);
  });
  it('requires first-login MFA enrolment without issuing a password-only session', () => {
    expect(firstLogin.mfaRequired).toBe(true);
    expect(firstLogin.stage).toBe('enrol');
    expect(firstLogin.accessToken).toBeUndefined();
    expect(firstCookies).toBeUndefined();
    expect(recoveryCodes).toHaveLength(10);
  });
  it('exposes only content:manage in the real authenticated actor', async () => {
    const me = await call('GET', '/v1/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().permissions).toEqual(['content:manage']);
    expect(me.json().roles).toEqual(['content_editor']);
  });
  it.each(['/dashboard', '/entries', '/media', '/config', '/vendors'])('allows editorial reads at %s', async path => {
    expect((await call('GET', BASE + path)).statusCode).toBe(200);
  });
  it('uploads media using the ordinary Studio media API', async () => {
    const data = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    const response = await call('POST', `${BASE}/media`, { filename: 'editor.png', title: 'Editor art', alt: 'Editorial artwork', contentType: 'image/png', data: data.toString('base64') });
    expect(response.statusCode, response.body).toBe(201);
  });
  it('creates/edits drafts and reads history while leaving the public feed unchanged', async () => {
    const created = await call('POST', `${BASE}/entries`, draft);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const edited = await call('PUT', `${BASE}/entries/${id}`, { version: 1, content: { ...draft, title: 'Updated draft' } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().draft.title).toBe('Updated draft');
    expect((await call('GET', `${BASE}/entries/${id}/history`)).json().revisions).toHaveLength(2);
    const feed = await call('GET', '/v1/content', undefined, {});
    expect(feed.json().items.some((item: { id: string }) => item.id === id)).toBe(false);
  });
  it.each(['publish', 'unpublish', 'rollback'])('rejects direct %s before record lookup or validation', async action => {
    const created = await call('POST', `${BASE}/entries`, draft);
    const id = created.json().id;
    const response = await call('POST', `${BASE}/entries/${id}/${action}`, { version: 1 });
    expect(response.statusCode, response.body).toBe(403);
    expect((await call('GET', `${BASE}/entries/${id}`)).json().version).toBe(1);
    expect((await call('POST', `${BASE}/entries/not-a-real-id/${action}`, {})).statusCode).toBe(403);
  });
  it('leaves Super Admin able to publish, roll back and unpublish editor drafts', async () => {
    const created = await call('POST', `${BASE}/entries`, draft);
    const id = created.json().id;
    const published = await call('POST', `${BASE}/entries/${id}/publish`, { version: 1 }, adminHeaders);
    expect(published.statusCode, published.body).toBe(200);
    const revisionId = published.json().publishedRevisionId;
    const edited = await call('PUT', `${BASE}/entries/${id}`, { version: 2, content: { ...draft, title: 'Next draft' } });
    expect(edited.statusCode).toBe(200);
    expect((await call('POST', `${BASE}/entries/${id}/publish`, { version: 3 }, adminHeaders)).statusCode).toBe(200);
    expect((await call('POST', `${BASE}/entries/${id}/rollback`, { version: 4, revisionId }, adminHeaders)).statusCode).toBe(200);
    expect((await call('POST', `${BASE}/entries/${id}/unpublish`, { version: 5 }, adminHeaders)).statusCode).toBe(200);
  });
  it('denies operational console APIs while keeping Super Admin access', async () => {
    expect((await call('GET', '/v1/admin/audit')).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/audit', undefined, adminHeaders)).statusCode).toBe(200);
  });
  it('refuses duplicate identities including legacy mixed-case emails without changing roles', async () => {
    await expect(provisionContentEditor(ctx.prisma, { email: email.toUpperCase(), displayName: 'Duplicate', password })).rejects.toThrow('already exists');
    await ctx.prisma.identity.create({ data: { email: 'LegacyEditor@dashapp.test', displayName: 'Legacy' } });
    await expect(provisionContentEditor(ctx.prisma, { email: 'legacyeditor@dashapp.test', displayName: 'Duplicate', password })).rejects.toThrow('already exists');
    expect((await ctx.prisma.identityRole.findMany({ where: { identityId } })).map(r => r.role)).toEqual(['content_editor']);
  });
  it.each([
    { email: 'invalid', displayName: 'Employee', password },
    { email: 'invalid-input@dashapp.test', displayName: '', password },
    { email: 'invalid-input@dashapp.test', displayName: 'Employee', password: 'short' },
  ])('rejects invalid provisioning input without writing an identity', async input => {
    const count = await ctx.prisma.identity.count();
    await expect(provisionContentEditor(ctx.prisma, input)).rejects.toThrow();
    expect(await ctx.prisma.identity.count()).toBe(count);
  });
  it('guards the operator CLI against non-staging targets', () => {
    for (const url of ['file:local.db', 'postgresql://localhost/dashdb', 'postgresql://localhost/dashdb_production']) {
      expect(() => assertContentEditorStagingTarget(url)).toThrow();
    }
    expect(() => assertContentEditorStagingTarget('postgresql://localhost/dashdb_staging')).not.toThrow();
  });
  it('supports existing single-use MFA recovery and revokes the Studio session on logout', async () => {
    const login = await call('POST', '/v1/auth/login', { email, password }, {});
    expect(login.json().stage).toBe('verify');
    const payload = { challengeToken: login.json().challengeToken, recoveryCode: recoveryCodes[0] };
    const recovered = await call('POST', '/v1/auth/mfa/verify', payload, {});
    expect(recovered.statusCode, recovered.body).toBe(200);
    const headers = headersFor(recovered.json());
    const signedOut = await call('POST', '/v1/auth/logout', undefined, headers);
    expect(signedOut.statusCode, signedOut.body).toBe(200);
    expect((await call('GET', '/v1/auth/me', undefined, headers)).statusCode).toBe(401);
    const second = await call('POST', '/v1/auth/login', { email, password }, {});
    expect((await call('POST', '/v1/auth/mfa/verify', { ...payload, challengeToken: second.json().challengeToken }, {})).statusCode).toBe(400);
  });
});
