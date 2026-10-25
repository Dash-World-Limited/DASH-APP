/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import ContentStudio from './page';

const { request, session } = vi.hoisted(() => ({
  request: vi.fn(),
  session: {
    loaded: true,
    me: null as null | {
      permissions: string[];
      identity: { displayName: string; email: string };
    },
  },
}));
vi.mock('@/lib/session', () => ({
  authedFetch: request,
  useMe: () => session,
}));
vi.mock('@/components/brand/DashWordmark', () => ({
  DashWordmark: () => <span>DASH</span>,
}));
afterEach(cleanup);
beforeEach(() => {
  session.me = {
    permissions: ['content:manage'],
    identity: { displayName: 'Editorial test', email: 'editor@dash.test' },
  };
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (path.endsWith('/entries')) return { entries: [], nextCursor: null };
    if (path.endsWith('/media')) return { assets: [], nextCursor: null };
    if (path.endsWith('/dashboard'))
      return {
        drafts: 0,
        published: 0,
        media: 0,
        recentlyUpdated: [],
        recentlyPublished: [],
      };
    if (path.includes('/vendors')) return { vendors: [] };
    return { revisions: [] };
  });
});
describe('Studio editorial surface', () => {
  it('does not mount privileged controls or fetch content for a non-editor', () => {
    session.me!.permissions = [];
    render(<ContentStudio />);
    expect(
      screen.queryByRole('button', { name: '+ Create content' }),
    ).toBeNull();
    expect(
      screen.getByText('This account does not have content management access.'),
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
  it('shows the empty dashboard and accessible editorial navigation', async () => {
    render(<ContentStudio />);
    expect(await screen.findByText('Presentation, with purpose.')).toBeTruthy();
    expect(
      screen.getByRole('navigation', { name: 'Content Studio' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/v1/admin/content/dashboard'),
    );
  });
  it('requires a saved draft and preview before enabling publication', async () => {
    const content = {
      internalName: 'Working title',
      type: 'announcement',
      placement: 'home.announcements',
      title: 'News',
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
    render(<ContentStudio />);
    fireEvent.click(screen.getByRole('button', { name: '+ Create content' }));
    fireEvent.change(screen.getByLabelText('Content type'), {
      target: { value: 'announcement' },
    });
    fireEvent.change(screen.getByLabelText('Internal name'), {
      target: { value: 'Working title' },
    });
    fireEvent.change(screen.getByLabelText('Display title'), {
      target: { value: 'News' },
    });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish…' })
        .disabled,
    ).toBe(true);
    request.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path.endsWith('/entries') && options?.method === 'POST')
          return {
            id: 'c1234567890123456789012345',
            version: 1,
            draft: content,
            publishedRevisionId: null,
            updatedBy: 'editor',
            updatedAt: new Date().toISOString(),
          };
        if (path.endsWith('/entries')) return { entries: [], nextCursor: null };
        if (path.endsWith('/media')) return { assets: [], nextCursor: null };
        if (path.endsWith('/dashboard'))
          return {
            drafts: 1,
            published: 0,
            media: 0,
            recentlyUpdated: [],
            recentlyPublished: [],
          };
        if (path.includes('/vendors')) return { vendors: [] };
        return { revisions: [] };
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. The live revision is unchanged.');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish…' })
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish…' })
        .disabled,
    ).toBe(false);
    fireEvent.change(screen.getByLabelText('Display title'), {
      target: { value: 'Unfinished change' },
    });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish…' })
        .disabled,
    ).toBe(true);
  });
});
