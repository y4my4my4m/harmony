/**
 * Android: a tap on the editor's text focuses the editor, raises the keyboard and moves the caret.
 *
 * Chromium on Android (Chrome and the WebView) opens its spelling suggestion menu
 * (TextSuggestionHost) whenever a tap lands on a word marked misspelled. With the keyboard up the
 * menu opens over it, and on some keyboards takes the keyboard down with it. With the keyboard
 * down the menu opens instead of the keyboard, whether the editor held focus or not: a tap on an
 * underlined word never brings the keyboard up (WebView 155 and Chrome 155, API 35, Gboard;
 * measured 2026-10-28).
 *
 * A tap has its default prevented, which keeps Chromium from handling it as a tap. The editor is
 * focused inside the touchend, whose user activation makes Chromium raise the keyboard for the
 * focus, also for an editor already focused; the caret is placed at the touch point. The
 * keyboard's suggestion strip offers corrections for the word at the caret. The second tap of a
 * double tap runs natively: double-tapping a misspelled word opens the menu. A second single tap
 * in the same word only moves the caret again: on some phones the menu took the keyboard down
 * with it even when opened on purpose (Gboard, 2026-10-21; not on API 33 or 35 emulators).
 *
 * Long presses, drags, multi-touch and taps on anything but editable text run natively.
 */

const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
// A second tap this soon after a handled one, this close to it, is a double tap.
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;

export function isAndroidUserAgent(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bAndroid\b/i.test(ua);
}

/** Attaches the tap handling to `editor`; returns the detach. */
export function attachTapToCaret(editor: HTMLElement): () => void {
  const doc = editor.ownerDocument;
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
    const touch = event.changedTouches[0];
    if (Math.hypot(touch.clientX - began.x, touch.clientY - began.y) > TAP_SLOP_PX) return;
    if (event.timeStamp - began.at > TAP_MAX_MS) return;

    const range = doc.caretRangeFromPoint?.(touch.clientX, touch.clientY);
    const node = range?.startContainer;
    if (!range || !node || node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return;
    // A mention pill (contenteditable=false) is atomic: the caret cannot enter it.
    const pill = node.parentElement?.closest('[contenteditable="false"]');
    if (pill && editor.contains(pill)) return;

    const selection = doc.getSelection();
    if (!selection) return;
    const previous = handled;
    handled = null;
    if (previous && event.timeStamp - previous.at <= DOUBLE_TAP_MS
      && Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) <= DOUBLE_TAP_PX) return;

    event.preventDefault();
    editor.focus({ preventScroll: true });
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
