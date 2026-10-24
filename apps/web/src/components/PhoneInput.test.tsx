// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getCountries } from '@dash/domain/phone';
import { PhoneInput } from './PhoneInput';
import { renderToString } from 'react-dom/server';
afterEach(cleanup);

it('renders stable country labels regardless of runtime ICU version', () => {
  const displayNames = vi.spyOn(Intl, 'DisplayNames').mockImplementation(() => { throw new Error('Do not depend on runtime ICU labels'); });
  try {
    expect(renderToString(<PhoneInput id="phone" onChange={() => {}} />).replace(/<!--.*?-->/g, '')).toContain('Falkland Islands (+500)');
    render(<PhoneInput id="phone" onChange={() => {}} />);
    expect(screen.getByRole('option', { name: 'Falkland Islands (+500)' })).toBeTruthy();
    expect(displayNames).not.toHaveBeenCalled();
  } finally { displayNames.mockRestore(); }
});

it('offers every country and emits E.164 while keeping the national input', () => {
  const change = vi.fn();
  render(<PhoneInput id="phone" onChange={change} />);
  const country = screen.getByLabelText('Country') as HTMLSelectElement;
  expect([...country.options].map(option => option.value).sort()).toEqual([...getCountries()].sort());
  expect(screen.getByRole('option', { name: 'Nigeria (+234)' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Local phone number'), { target: { value: '0801 234 5678' } });
  expect(change).toHaveBeenLastCalledWith('+2348012345678');
  expect((screen.getByLabelText('Local phone number') as HTMLInputElement).value).toBe('0801 234 5678');
  fireEvent.change(country, { target: { value: 'GB' } });
  expect(change).toHaveBeenLastCalledWith('');
  expect(screen.getByRole('alert').textContent).toContain('United Kingdom');
  fireEvent.change(screen.getByLabelText('Local phone number'), { target: { value: '07400123456' } });
  expect(change).toHaveBeenLastCalledWith('+447400123456');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('prefills an existing E.164 value as country and national number, then clears invalid output', () => {
  const change = vi.fn();
  render(<PhoneInput id="phone" defaultValue="+390236618300" onChange={change} />);
  expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('IT');
  expect((screen.getByLabelText('Local phone number') as HTMLInputElement).value).toContain('02');
  fireEvent.change(screen.getByLabelText('Local phone number'), { target: { value: '02' } });
  expect(change).toHaveBeenLastCalledWith('');
  fireEvent.blur(screen.getByLabelText('Local phone number'));
  expect(screen.getByLabelText('Local phone number').getAttribute('aria-invalid')).toBe('true');
});
