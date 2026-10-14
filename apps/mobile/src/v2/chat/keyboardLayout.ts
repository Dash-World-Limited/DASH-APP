/**
 * How the order chat stays clear of the software keyboard.
 *
 * Expo SDK 57 draws Android apps edge to edge, and an edge-to-edge window is
 * never resized for the keyboard, so `softwareKeyboardLayoutMode: 'resize'`
 * no longer lifts anything. The chat has to make room itself. On both
 * platforms that means a KeyboardAvoidingView with `padding`; on Android its
 * behaviour used to be left undefined, which is why the composer sat under the
 * keyboard on the Samsung A55.
 *
 * KeyboardAvoidingView compares its own frame, which is relative to its
 * parent, with the keyboard's top edge, which is in window coordinates. The
 * chat sits below the status-bar inset (and, for a rider, sometimes an offer
 * banner), so the offset is where the chat actually starts in the window,
 * measured, never a hard-coded height.
 */

export type KeyboardPlatform = 'ios' | 'android' | string;

export const CHAT_KEYBOARD_BEHAVIOR = 'padding' as const;

/**
 * Scrolling the conversation never closes the keyboard on Android, so earlier
 * messages can be read while typing. iOS keeps its interactive swipe-down.
 */
export function chatKeyboardDismissMode(platform: KeyboardPlatform): 'interactive' | 'none' {
  return platform === 'ios' ? 'interactive' : 'none';
}

/** The KeyboardAvoidingView offset for a chat whose top is `windowY` down the window. */
export function keyboardOffsetFrom(windowY: number): number {
  return Number.isFinite(windowY) && windowY > 0 ? Math.round(windowY) : 0;
}
