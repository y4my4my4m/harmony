/**
 * Android: a tap in a focused editor only moves the caret.
 *
 * Chromium on Android (Chrome and the WebView) opens its spelling suggestion menu
 * (TextSuggestionHost) whenever a tap lands on a word marked misspelled, so going back to fix a
 * word opens a menu over it, and on some keyboards the menu takes the keyboard down with it.
 * A tap that would move the caret into another word has its default prevented, which keeps
 * Chromium from handling it as a tap, and the caret is placed at the touch point here; the
 * keyboard's own suggestion strip follows the caret. A tap on the word the caret is already in
 * runs natively: tapping a misspelled word twice opens the menu.
 *
 * Long presses, drags, multi-touch and taps on anything but text run natively, and so does
 * every tap while the keyboard is down, so the tap that brings the keyboard back still does.
 */

const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
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

/** Offsets of the run of non-space characters around `offset` in `text`. */
export function wordBounds(text: string, offset: number): { start: number; end: number } {
  let start = offset;
  let end = offset;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start, end };
}

/** Attaches the tap handling to `editor`; returns the detach. */
export function attachTapToCaret(
  editor: HTMLElement,
  opts: { keyboardOpen?: () => boolean } = {},
): () => void {
  const keyboardOpen = opts.keyboardOpen ?? keyboardLikelyOpen;
  let start: { x: number; y: number; at: number } | null = null;

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
    if (selection.isCollapsed && selection.anchorNode === node) {
      const current = wordBounds(node.textContent ?? '', selection.anchorOffset);
      if (current.end > current.start && range.startOffset >= current.start && range.startOffset <= current.end) return;
    }

    event.preventDefault();
    selection.collapse(node, range.startOffset);
  };

  editor.addEventListener('touchstart', onTouchStart, { passive: true });
  editor.addEventListener('touchend', onTouchEnd, { passive: false });
  return () => {
    editor.removeEventListener('touchstart', onTouchStart);
    editor.removeEventListener('touchend', onTouchEnd);
  };
}
