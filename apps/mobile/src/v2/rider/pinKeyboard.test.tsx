// @vitest-environment jsdom
/**
 * The delivery PIN stays above the keyboard.
 *
 * The PIN is typed into the footer of the rider workspace's bottom panel. On
 * an edge-to-edge Android window nothing resized for the keyboard, so the PIN
 * and its button were covered. The workspace now sits in KeyboardSafeView —
 * the pattern that fixed the order chat — and these tests hold both halves:
 * the component makes room using its measured position, and the workspace is
 * wrapped in it without the PIN rules changing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ avoiding: [] as Array<Record<string, unknown>>, layout: null as null | (() => void), windowY: 0 }));

vi.mock('react-native', () => {
  const View = forwardRef(function View(props: { children?: ReactNode; onLayout?: () => void }, ref) {
    useImperativeHandle(ref, () => ({
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, seen.windowY, 360, 700),
    }));
    if (props.onLayout) seen.layout = props.onLayout;
    return createElement('div', null, props.children);
  });
  function KeyboardAvoidingView(props: Record<string, unknown> & { children?: ReactNode }) {
    seen.avoiding.push(props);
    return createElement('div', null, props.children);
  }
  return { View, KeyboardAvoidingView };
});

import { KeyboardSafeView } from '../chat/KeyboardSafeView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const riderScreens = readFileSync(join(here, 'RiderScreens.tsx'), 'utf8');
const safeView = readFileSync(join(here, '../chat/KeyboardSafeView.tsx'), 'utf8');

describe('KeyboardSafeView', () => {
  it('pads for the keyboard, offset by where it really starts on screen', async () => {
    seen.windowY = 52.6;
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(KeyboardSafeView, null, 'workspace')));
    expect(seen.avoiding.at(-1)).toMatchObject({ behavior: 'padding', keyboardVerticalOffset: 0 });

    await act(async () => seen.layout?.());
    expect(seen.avoiding.at(-1)).toMatchObject({ behavior: 'padding', keyboardVerticalOffset: 53 });
    await act(async () => root.unmount());
  });

  it('never uses a hard-coded height', () => {
    expect(safeView).toContain('keyboardVerticalOffset={offset}');
    expect(safeView).not.toMatch(/keyboardVerticalOffset=\{\d/);
    expect(safeView).not.toMatch(/behavior=\{Platform/);
  });
});

describe('the rider workspace with the delivery PIN', () => {
  it('sits inside KeyboardSafeView, keeping its test id', () => {
    expect(riderScreens).toMatch(/<KeyboardSafeView testID="rider-workspace-v2"/);
    expect(riderScreens).toContain('</KeyboardSafeView>');
  });

  it('keeps the PIN rules exactly as they were', () => {
    expect(riderScreens).toContain("onChangeText={(value) => setPin(value.replace(/\\D/g, '').slice(0, 4))}");
    expect(riderScreens).toContain('disabled={flow.busy || pin.length !== 4}');
    expect(riderScreens).toContain('onPress={() => void flow.complete(pin)}');
  });
});
