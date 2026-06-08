// Editable fields must always defer to the browser's native menu so users can
// paste, select-all, look up, etc. (right-click on desktop, long-press on
// mobile/PWA) — even when nothing is currently selected (e.g. empty input).
const EDITABLE_FIELD_SELECTOR =
  'input:not([readonly]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea:not([readonly]), [contenteditable="true"], [contenteditable=""]';

const SELECTABLE_CONTENT_SELECTOR =
  '.message-content, .content-display, .post-text, .post-body, .selectable';

const NATIVE_MEDIA_SELECTOR = 'a, img, video, audio, [data-no-context-menu]';

function hasActiveTextSelection(): boolean {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  return selection.toString().length > 0;
}

function selectionContainsNode(node: Node): boolean {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  try {
    return selection.containsNode(node, true);
  } catch {
    return false;
  }
}

/**
 * Whether the browser's native context menu should take over instead of a
 * custom in-app menu. Covers selected text (Copy), links, and media.
 */
export function shouldAllowNativeContextMenu(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Node)) return hasActiveTextSelection();

  // Editable fields: always allow the native menu (paste, select all, etc.),
  // regardless of whether text is currently selected.
  if (target instanceof HTMLElement && target.closest(EDITABLE_FIELD_SELECTOR)) {
    return true;
  }

  if (target instanceof HTMLElement && target.closest(NATIVE_MEDIA_SELECTOR)) {
    return true;
  }

  if (hasActiveTextSelection() || selectionContainsNode(target)) {
    return true;
  }

  if (target instanceof HTMLElement && target.closest(SELECTABLE_CONTENT_SELECTOR)) {
    // Right-click inside message/post text without a custom menu target:
    // defer to the browser so users can paste, look up, etc.
    return hasActiveTextSelection();
  }

  return false;
}
