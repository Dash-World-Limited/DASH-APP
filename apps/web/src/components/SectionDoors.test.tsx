// @vitest-environment jsdom

/**
 * The five front doors.
 *
 * This is the app's structure made visible, so the failure modes are product
 * failures rather than visual ones: a sixth door, a missing door, a door that
 * leads somewhere else, or one door given more weight than the other four —
 * which has happened once already, when Declutter was rendered as a full-width
 * banner above the rest and turned a multi-service marketplace into a
 * second-hand app with extras.
 *
 * Equality is the property being defended, and it is testable: five tiles, one
 * markup shape, one set of classes, no counts or claims on any of them.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SectionDoors } from './SectionDoors';
import { SECTIONS } from '@/lib/sections';

afterEach(cleanup);

describe('the doors', () => {
  it('shows the five locked sections and nothing else', () => {
    render(<SectionDoors />);
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Shops',
      'Restaurants',
      'Local Market',
      'Pharmacy',
      'Declutter',
    ]);
  });

  it('reintroduces none of the old top-level names', () => {
    // `Everything`, `Food`, `Groceries` and `Essentials` were the previous
    // structure. Groceries is inside Shops now; a door with that name would put
    // it back alongside its own parent.
    render(<SectionDoors />);
    const text = screen.getByRole('navigation').textContent ?? '';
    for (const legacy of ['Everything', 'Food', 'Groceries', 'Essentials']) {
      expect(text, legacy).not.toContain(legacy);
    }
  });

  it('sends each door to its own section', () => {
    render(<SectionDoors />);
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(
      SECTIONS.map((section) => `/${section.slug}`),
    );
  });

  it('is a navigation, so it can be skipped to and skipped over', () => {
    render(<SectionDoors />);
    expect(screen.getByRole('navigation').getAttribute('aria-label')).toBe('Sections');
  });
});

describe('equality', () => {
  it('gives every door the same tile', () => {
    // Same classes means same size, same weight, same treatment. One door
    // styled differently is one door presented as the point of the app.
    render(<SectionDoors />);
    const shapes = new Set(screen.getAllByRole('link').map((link) => link.className));
    expect(shapes.size).toBe(1);
  });

  it('gives every door the same cell in the grid', () => {
    // The fourth starts a column in on narrow screens — that is what centres
    // the second row — but every tile spans the same number of columns.
    const { container } = render(<SectionDoors />);
    const cells = [...container.querySelectorAll('li')];
    expect(cells).toHaveLength(SECTIONS.length);
    for (const cell of cells) {
      expect(cell.className).toContain('col-span-2');
      expect(cell.className).toContain('sm:col-span-1');
    }
  });

  it('gives each door its own mark', () => {
    // Five identical glyphs would make the row a wall of text; five colours on
    // five cards would make it a rainbow. One tinted mark per door.
    const { container } = render(<SectionDoors />);
    const marks = [...container.querySelectorAll('svg')];
    expect(marks).toHaveLength(SECTIONS.length);
    const paths = marks.map((mark) => mark.innerHTML);
    expect(new Set(paths).size).toBe(SECTIONS.length);
  });
});

describe('honesty', () => {
  it('claims nothing about any section', () => {
    // No counts, no "popular", no "24 sellers nearby". None of it is known
    // here, and a marketplace that invents activity is a marketplace nobody
    // should trust with a payment.
    render(<SectionDoors />);
    const text = screen.getByRole('navigation').textContent ?? '';
    expect(text).not.toMatch(/\d/);
    for (const claim of ['popular', 'trending', 'nearby', 'new', 'best']) {
      expect(text.toLowerCase(), claim).not.toContain(claim);
    }
  });
});
