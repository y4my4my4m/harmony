/**
 * Android: a tap in a focused editor only moves the caret.
 *
 * Chromium on Android (Chrome and the WebView) opens its spelling suggestion menu
 * (TextSuggestionHost) whenever a tap lands on a word marked misspelled, so going back to fix a
 * word opens a menu over it, and on some keyboards the menu takes the keyboard down with it.
 * A tap has its default prevented, which keeps Chromium from handling it as a tap, and the caret
 * is placed at the touch point here; the keyboard's suggestion strip offers corrections for the
 * word at the caret. The second tap of a double tap runs natively: double-tapping a misspelled
 * word opens the menu. A second single tap in the same word only moves the caret again: on some
 * phones the menu took the keyboard down with it even when opened on purpose (Gboard, 2026-10-21;
 * not on API 33 or 35 emulators).
 *
 * Long presses, drags, multi-touch and taps on anything but text run natively, and so does
 * every tap while the keyboard is down, so the tap that brings the keyboard back still does.
 */

const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
// A second tap this soon after a handled one, this close to it, is a double tap.
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;
// Measured on a Pixel 7 (API 35): the visual viewport is 76 CSS px short of the screen with the
// keyboard down (system bars) and 388 px short with Gboard up.
const KEYBOARD_GAP_PX = 200;

export function isAndroidUserAgent(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bAndroid\b/i.test(ua);
}

/** The on-screen keyboard is up: it takes its height out of the visual viewport. */
export function keyboardLikelyOpen(): boolean {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  return window.screen.availHeight - viewport > KEYBOARD_GAP_PX;
}

/** Attaches the tap handling to `editor`; returns the detach. */
export function attachTapToCaret(
  editor: HTMLElement,
  opts: { keyboardOpen?: () => boolean } = {},
): () => void {
  const keyboardOpen = opts.keyboardOpen ?? keyboardLikelyOpen;
  let start: { x: number; y: number; at: number } | null = null;
  let handled: { x: number; y: number; at: number } | null = null;

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    start = touch ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp } : null;
  };

  const onTouchEnd = (event: TouchEvent) => {
    const began = start;
    start = null;
    if (!began || event.changedTouches.length !== 1 || event.touches.length > 0) return;
    if (document.activeElement !== editor || !keyboardOpen()) return;
    const touch = event.changedTouches[0];
    if (Math.hypot(touch.clientX - began.x, touch.clientY - began.y) > TAP_SLOP_PX) return;
    if (event.timeStamp - began.at > TAP_MAX_MS) return;

    const range = document.caretRangeFromPoint?.(touch.clientX, touch.clientY);
    const node = range?.startContainer;
    if (!range || !node || node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return;

    const selection = window.getSelection();
    if (!selection) return;
    const previous = handled;
    handled = null;
    if (previous && event.timeStamp - previous.at <= DOUBLE_TAP_MS
      && Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) <= DOUBLE_TAP_PX) return;

    event.preventDefault();
    selection.collapse(node, range.startOffset);
    handled = { x: touch.clientX, y: touch.clientY, at: event.timeStamp };
  };

  editor.addEventListener('touchstart', onTouchStart, { passive: true });
  editor.addEventListener('touchend', onTouchEnd, { passive: false });
  return () => {
    editor.removeEventListener('touchstart', onTouchStart);
    editor.removeEventListener('touchend', onTouchEnd);
  };
}
