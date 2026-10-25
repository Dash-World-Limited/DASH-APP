/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import StudioSignInPage from '@/app/studio/signin/page';
import AdminSignInPage from '@/app/admin/signin/page';
import { AdminShell } from '@/components/admin/AdminShell';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(), login: vi.fn(), verify: vi.fn(), recovery: vi.fn(), start: vi.fn(), confirm: vi.fn(), me: vi.fn(), signOut: vi.fn(),
  actor: { roles: ['content_editor'], permissions: ['content:manage'], identity: { email: 'editor@dashapp.test', displayName: 'Editor' } },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => '/admin' }));
vi.mock('@/lib/session', () => ({
  signInWithPassword: mocks.login, verifyMfa: mocks.verify, verifyMfaWithRecoveryCode: mocks.recovery,
  beginMfaEnrolment: mocks.start, confirmMfaEnrolment: mocks.confirm, loadMe: mocks.me, signOut: mocks.signOut,
  useMe: () => ({ me: mocks.actor, loaded: true }),
}));
vi.mock('@/components/admin/AdminTheme', () => ({
  useAdminTheme: () => ({ theme: 'light', setTheme: vi.fn() }), AdminThemeToggle: () => null,
}));
vi.mock('@/components/brand/DashWordmark', () => ({ DashWordmark: () => <span>DASH</span> }));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.roles = ['content_editor'];
  mocks.actor.permissions = ['content:manage'];
  mocks.login.mockResolvedValue({ kind: 'mfa_required', challengeToken: 'password-challenge', stage: 'verify' });
  mocks.verify.mockResolvedValue({ accessToken: 'session' });
  mocks.recovery.mockResolvedValue({ accessToken: 'session' });
  mocks.start.mockResolvedValue({ secret: 'SETUP-KEY', otpauthUri: 'otpauth://totp/DASH' });
  mocks.confirm.mockResolvedValue({ recoveryCodes: ['RECOVERY-ONE', 'RECOVERY-TWO'] });
  mocks.me.mockImplementation(async () => mocks.actor);
  mocks.signOut.mockResolvedValue(undefined);
});
function fillCredentials() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'editor@dashapp.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'FixtureOnly!Password' } });
}
async function credentials() {
  fillCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Continue securely' }));
  await screen.findByLabelText('Authenticator code');
}
async function verify(label = 'Enter Content Studio') {
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('dedicated Studio sign-in on the existing password/MFA foundation', () => {
  it('authenticates content_editor using password then MFA and content permission', async () => {
    render(<StudioSignInPage />);
    await credentials();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.login).toHaveBeenCalledWith('editor@dashapp.test', 'FixtureOnly!Password');
    await verify();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/studio'));
    expect(mocks.verify).toHaveBeenCalledWith('password-challenge', '123456');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it('enrols with existing APIs and shows recovery codes before entry', async () => {
    mocks.login.mockResolvedValue({ kind: 'mfa_required', stage: 'enrol', challengeToken: 'enrol-challenge' });
    render(<StudioSignInPage />);
    await credentials();
    expect(mocks.start).toHaveBeenCalledWith('enrol-challenge');
    expect(screen.getByText('SETUP-KEY')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate authenticator' }));
    expect(await screen.findByText('RECOVERY-ONE')).toBeTruthy();
    expect(mocks.confirm).toHaveBeenCalledWith('enrol-challenge', '123456');
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'I saved them — enter Content Studio' }));
    expect(mocks.replace).toHaveBeenCalledWith('/studio');
  });
  it('supports the existing recovery-code verification endpoint', async () => {
    render(<StudioSignInPage />);
    await credentials();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'ABCD-RECOVERY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Content Studio' }));
    await waitFor(() => expect(mocks.recovery).toHaveBeenCalledWith('password-challenge', 'ABCD-RECOVERY'));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/studio'));
  });
  it('revokes a completed MFA session lacking content:manage and shows the required denial', async () => {
    mocks.actor.roles = ['support_agent']; mocks.actor.permissions = [];
    render(<StudioSignInPage />);
    await credentials(); await verify();
    expect(await screen.findByText('This account does not have DASH Content Studio access')).toBeTruthy();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('revokes password-only non-editor sessions with the same access denial', async () => {
    mocks.login.mockResolvedValue({ kind: 'session' }); mocks.actor.permissions = [];
    render(<StudioSignInPage />);
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Continue securely' }));
    expect(await screen.findByText('This account does not have DASH Content Studio access')).toBeTruthy();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });
  it('fails closed if a privileged password response bypasses MFA', async () => {
    mocks.login.mockResolvedValue({ kind: 'session' });
    render(<StudioSignInPage />);
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Continue securely' }));
    expect(await screen.findByText(/Privileged sign-in is not requiring MFA/)).toBeTruthy();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('keeps the existing admin sign-in restricted to Super Admin', async () => {
    render(<AdminSignInPage />);
    await credentials(); await verify('Enter Control Centre');
    expect(await screen.findByText('This account is not a DASH Super Admin account.')).toBeTruthy();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('preserves Super Admin sign-in and destination', async () => {
    mocks.actor.roles = ['super_admin']; mocks.actor.permissions = ['content:manage', 'content:publish'];
    render(<AdminSignInPage />);
    await credentials(); await verify('Enter Control Centre');
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/admin'));
  });
  it('denies /admin and never mounts its navigation or children for content_editor', () => {
    render(<AdminShell><div>Secret operational child</div></AdminShell>);
    expect(screen.getByText('Super Admin access only')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Super Admin' })).toBeNull();
    expect(screen.queryByText('Secret operational child')).toBeNull();
  });
});
