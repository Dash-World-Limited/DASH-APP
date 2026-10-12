// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  DeclutterThemeShell,
  DeclutterThemeToggle,
  DECLUTTER_THEME_KEY,
  preferredTheme,
  themeBootstrap,
} from './DeclutterTheme';

let dark = false;
let change: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear();
  dark = false;
  change = undefined;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, callback: () => void) => {
        change = callback;
      },
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function surface() {
  return render(
    <DeclutterThemeShell>
      <DeclutterThemeToggle />
      <p>Declutters</p>
    </DeclutterThemeShell>,
  );
}

it.each([
  ['light', true, 'light'],
  ['dark', false, 'dark'],
  [null, true, 'dark'],
  ['invalid', false, 'light'],
] as const)(
  'selects stored or system theme (%s)',
  (saved, system, expected) => {
    expect(preferredTheme(saved, system)).toBe(expected);
  },
);
it('toggles with an accessible icon control, persists the choice and restores it on reload', async () => {
  const first = surface();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Switch to dark mode' }),
  );
  expect(localStorage.getItem(DECLUTTER_THEME_KEY)).toBe('dark');
  expect(
    first.container
      .querySelector('[data-declutter-theme]')
      ?.getAttribute('data-declutter-theme'),
  ).toBe('dark');
  first.unmount();
  surface();
  expect(
    await screen.findByRole('button', { name: 'Switch to light mode' }),
  ).toBeTruthy();
});
it('follows system changes only until the user records a choice, and syncs another tab', async () => {
  surface();
  await screen.findByRole('button', { name: 'Switch to dark mode' });
  dark = true;
  change?.();
  await screen.findByRole('button', { name: 'Switch to light mode' });
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
  dark = true;
  change?.();
  expect(
    screen.getByRole('button', { name: 'Switch to dark mode' }),
  ).toBeTruthy();
  localStorage.setItem(DECLUTTER_THEME_KEY, 'dark');
  fireEvent(
    window,
    new StorageEvent('storage', { key: DECLUTTER_THEME_KEY, newValue: 'dark' }),
  );
  await screen.findByRole('button', { name: 'Switch to light mode' });
});
it('still toggles if browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  surface();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Switch to dark mode' }),
  );
  await screen.findByRole('button', { name: 'Switch to light mode' });
});
it('bootstraps only its wrapper before paint, without changing the generic application root', async () => {
  const generic = document.createElement('div');
  generic.setAttribute('data-surface', 'customer');
  document.body.append(generic);
  const shell = document.createElement('div');
  const script = document.createElement('script');
  shell.append(script);
  document.body.append(shell);
  localStorage.setItem(DECLUTTER_THEME_KEY, 'light');
  const current = vi
    .spyOn(document, 'currentScript', 'get')
    .mockReturnValue(script);
  window.eval(themeBootstrap);
  expect(shell.dataset.declutterTheme).toBe('light');
  expect(generic.hasAttribute('data-declutter-theme')).toBe(false);
  expect(document.documentElement.hasAttribute('data-declutter-theme')).toBe(
    false,
  );
  current.mockRestore();
  shell.remove();
  generic.remove();
  await waitFor(() =>
    expect(localStorage.getItem(DECLUTTER_THEME_KEY)).toBe('light'),
  );
});
