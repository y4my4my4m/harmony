const SELECTABLE_CONTENT_SELECTOR =
  'input, textarea, [contenteditable], .message-content, .content-display, .post-text, .post-body, .selectable';

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
