'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { AdminThemeToggle, useAdminTheme } from '@/components/admin/AdminTheme';
import { DashWordmark } from '@/components/brand/DashWordmark';
import { ApiRequestError } from '@/lib/api';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  loadMe,
  signInWithPassword,
  signOut,
  verifyMfa,
} from '@/lib/session';

type Stage = 'credentials' | 'verify' | 'enrol' | 'recovery';

interface Challenge {
  token: string;
  stage: 'verify' | 'enrol';
}

function messageOf(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : 'Something went wrong. Please try again.';
}

export default function AdminSignInPage() {
  const router = useRouter();
  const { theme, setTheme } = useAdminTheme();
  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [secret, setSecret] = useState('');
  const [otpauthUri, setOtpauthUri] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function assertSuperAdmin(): Promise<boolean> {
    const me = await loadMe();
    if (me?.roles.includes('super_admin')) return true;
    await signOut();
    setError('This account is not a DASH Super Admin account.');
    setStage('credentials');
    return false;
  }

  async function submitCredentials() {
    setBusy(true);
    setError(null);
    try {
      const result = await signInWithPassword(email.trim().toLowerCase(), password);
      if (result.kind === 'session') {
        // A Super Admin is expected to require MFA. If configuration ever
        // allows a password-only privileged session, do not quietly accept it.
        await signOut();
        setError('Privileged sign-in is not requiring MFA. Check the server security configuration.');
        return;
      }

      const next: Challenge = {
        token: result.challengeToken,
        stage: result.stage,
      };
      setChallenge(next);
      setCode('');

      if (result.stage === 'enrol') {
        const offer = await beginMfaEnrolment(result.challengeToken);
        setSecret(offer.secret);
        setOtpauthUri(offer.otpauthUri);
        setStage('enrol');
      } else {
        setStage('verify');
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitVerify() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(challenge.token, code);
      if (await assertSuperAdmin()) router.replace('/ops/declutter');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
      setCode('');
    }
  }

  async function submitEnrolment() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmMfaEnrolment(challenge.token, code);
      if (!(await assertSuperAdmin())) return;
      setRecoveryCodes(result.recoveryCodes);
      setStage('recovery');
      setCode('');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      data-surface="admin"
      data-admin-theme={theme}
      className="admin-grid-glow min-h-screen bg-[var(--surface)] px-4 py-6 text-[var(--ink)] sm:px-6"
    >
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl items-stretch overflow-hidden rounded-[2rem] border border-[var(--line)] bg-[var(--surface-raised)] shadow-2xl">
        <aside className="relative hidden w-[42%] overflow-hidden bg-[#0B0D10] p-10 text-[#F4F1EA] lg:flex lg:flex-col">
          <div className="absolute -right-20 -top-16 h-64 w-64 rounded-full bg-[#A67834]/20 blur-3xl" />
          <div className="relative">
            <DashWordmark height="1.45rem" />
            <span className="ml-3 align-middle text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#9A968D]">
              Super Admin
            </span>
          </div>

          <div className="relative my-auto max-w-sm">
            <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#C4924A]">
              DASH Control Centre
            </p>
            <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-[-0.04em]">
              The platform,
              <br />
              under your control.
            </h1>
            <p className="mt-5 text-sm leading-7 text-[#A8A399]">
              Partner approvals, live operations, refunds and governance — protected by password, authenticator and audit trails.
            </p>
          </div>

          <div className="relative grid grid-cols-3 gap-2 text-center text-[10px] font-bold uppercase tracking-wide text-[#77736B]">
            <div className="rounded-xl border border-white/10 bg-white/[0.035] px-2 py-3">MFA</div>
            <div className="rounded-xl border border-white/10 bg-white/[0.035] px-2 py-3">Audited</div>
            <div className="rounded-xl border border-white/10 bg-white/[0.035] px-2 py-3">Scoped</div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col p-5 sm:p-8 lg:p-10">
          <div className="flex items-center justify-between gap-4">
            <div className="lg:hidden">
              <DashWordmark height="1.15rem" />
            </div>
            <div className="ml-auto w-40">
              <AdminThemeToggle theme={theme} onChange={setTheme} />
            </div>
          </div>

          <div className="mx-auto my-auto w-full max-w-md py-8">
            {stage === 'credentials' ? (
              <>
                <p className="admin-kicker">Secure access</p>
                <h2 className="mt-2 text-3xl font-extrabold tracking-[-0.035em]">Super Admin sign in</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
                  Use your dedicated administrator identity. Customer email-code sign-in cannot access this surface.
                </p>

                <form
                  className="mt-7 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitCredentials();
                  }}
                >
                  <label className="block">
                    <span className="text-xs font-bold text-[var(--ink-muted)]">Admin email</span>
                    <input
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="admin@dashworldng.com"
                      className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 text-sm font-semibold outline-none transition focus:border-[var(--primary)]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-bold text-[var(--ink-muted)]">Password</span>
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 text-sm font-semibold outline-none transition focus:border-[var(--primary)]"
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={busy}
                    className="min-h-12 w-full rounded-xl bg-[var(--primary)] px-5 text-sm font-extrabold text-[var(--on-primary)] transition hover:bg-[var(--primary-hover)] disabled:opacity-50"
                  >
                    {busy ? 'Checking credentials…' : 'Continue securely'}
                  </button>
                </form>
              </>
            ) : null}

            {stage === 'verify' ? (
              <>
                <p className="admin-kicker">Second factor</p>
                <h2 className="mt-2 text-3xl font-extrabold tracking-[-0.035em]">Confirm it’s you</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
                  Open your authenticator app and enter the current six-digit DASH code.
                </p>
                <form
                  className="mt-7 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitVerify();
                  }}
                >
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    autoFocus
                    aria-label="Authenticator code"
                    placeholder="000000"
                    className="min-h-16 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 text-center text-2xl font-extrabold tracking-[0.35em] outline-none focus:border-[var(--primary)]"
                  />
                  <button
                    type="submit"
                    disabled={busy || code.length !== 6}
                    className="min-h-12 w-full rounded-xl bg-[var(--primary)] px-5 text-sm font-extrabold text-[var(--on-primary)] disabled:opacity-50"
                  >
                    {busy ? 'Verifying…' : 'Enter Control Centre'}
                  </button>
                </form>
              </>
            ) : null}

            {stage === 'enrol' ? (
              <>
                <p className="admin-kicker">First-time security setup</p>
                <h2 className="mt-2 text-3xl font-extrabold tracking-[-0.035em]">Add DASH to your authenticator</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
                  This secret is shown once. Add it to Google Authenticator, Microsoft Authenticator, 1Password or another TOTP app, then enter the six-digit code it generates.
                </p>

                <div className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--surface-sunken)] p-4">
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Setup key</p>
                  <p className="mt-2 break-all font-mono text-sm font-bold leading-6">{secret}</p>
                  {otpauthUri ? (
                    <a
                      href={otpauthUri}
                      className="mt-3 inline-flex rounded-lg border border-[var(--line-strong)] bg-[var(--surface-raised)] px-3 py-2 text-xs font-bold text-[var(--primary)]"
                    >
                      Open in authenticator
                    </a>
                  ) : null}
                </div>

                <form
                  className="mt-5 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitEnrolment();
                  }}
                >
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    aria-label="Authenticator code"
                    placeholder="000000"
                    className="min-h-16 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 text-center text-2xl font-extrabold tracking-[0.35em] outline-none focus:border-[var(--primary)]"
                  />
                  <button
                    type="submit"
                    disabled={busy || code.length !== 6}
                    className="min-h-12 w-full rounded-xl bg-[var(--primary)] px-5 text-sm font-extrabold text-[var(--on-primary)] disabled:opacity-50"
                  >
                    {busy ? 'Activating…' : 'Activate authenticator'}
                  </button>
                </form>
              </>
            ) : null}

            {stage === 'recovery' ? (
              <>
                <p className="admin-kicker">Last security step</p>
                <h2 className="mt-2 text-3xl font-extrabold tracking-[-0.035em]">Save your recovery codes</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
                  These are shown once. Store them somewhere separate from your password and authenticator.
                </p>
                <div className="mt-6 grid grid-cols-2 gap-2 rounded-2xl border border-[var(--line)] bg-[var(--surface-sunken)] p-4">
                  {recoveryCodes.map((item) => (
                    <code key={item} className="rounded-lg bg-[var(--surface-raised)] px-3 py-2 text-center text-xs font-bold">
                      {item}
                    </code>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void copyRecoveryCodes()}
                  className="mt-3 min-h-10 w-full rounded-xl border border-[var(--line)] px-4 text-xs font-bold"
                >
                  {copied ? 'Copied' : 'Copy recovery codes'}
                </button>
                <button
                  type="button"
                  onClick={() => router.replace('/ops/declutter')}
                  className="mt-3 min-h-12 w-full rounded-xl bg-[var(--primary)] px-5 text-sm font-extrabold text-[var(--on-primary)]"
                >
                  I saved them — enter Super Admin
                </button>
              </>
            ) : null}

            {error ? (
              <div role="alert" className="mt-5 rounded-2xl bg-[var(--danger-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--danger)]">
                {error}
              </div>
            ) : null}

            {stage !== 'credentials' && stage !== 'recovery' ? (
              <button
                type="button"
                onClick={() => {
                  setStage('credentials');
                  setChallenge(null);
                  setSecret('');
                  setOtpauthUri('');
                  setCode('');
                  setError(null);
                }}
                className="mt-5 w-full text-center text-xs font-bold text-[var(--ink-muted)] underline underline-offset-4"
              >
                Start again
              </button>
            ) : null}
          </div>

          <p className="text-center text-[10px] leading-5 text-[var(--ink-muted)]">
            Privileged actions are permission checked, step-up protected and audited by the API.
          </p>
        </main>
      </div>
    </div>
  );
}
