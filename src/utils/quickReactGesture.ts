/**
 * Desktop double-click quick-react: which double-clicks count.
 *
 * A double-click reacts only on empty space in a message, with the primary button, no
 * modifier, both presses within QUICK_REACT_MAX_INTERVAL_MS and QUICK_REACT_MAX_DISTANCE_PX
 * of the first. A double-click on text is a word selection and is left to the browser.
 */

/** Targets whose own click or double-click behaviour takes precedence. */
export const QUICK_REACT_IGNORE_SELECTOR = [
  'a', 'button', 'img', 'video', 'audio', 'input', 'textarea', 'select', 'label', 'summary',
  'pre', 'code', '[contenteditable="true"]',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="slider"]',
  '.mention', '.message-reactions', '.message-actions', '.file-attachment',
  '[class*="embed"]', '[class*="spoiler"]', '[data-no-quick-react]',
].join(', ')

/** First press to the dblclick event (second release). OS defaults run 400-500 ms. */
export const QUICK_REACT_MAX_INTERVAL_MS = 400
export const QUICK_REACT_MAX_DISTANCE_PX = 6

export interface PointerDown {
  x: number
  y: number
  /** Event.timeStamp, ms. */
  time: number
}

export interface QuickReactDoubleClick {
  button: number
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  clientX: number
  clientY: number
  timeStamp: number
  target: EventTarget | null
}

export function isQuickReactDoubleClick(
  event: QuickReactDoubleClick,
  firstDown: PointerDown | null,
  overText: boolean,
): boolean {
  if (event.button !== 0) return false
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false
  const target = event.target as Element | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(QUICK_REACT_IGNORE_SELECTOR)) return false
  if (overText) return false
  if (!firstDown) return false
  if (event.timeStamp - firstDown.time > QUICK_REACT_MAX_INTERVAL_MS) return false
  const moved = Math.hypot(event.clientX - firstDown.x, event.clientY - firstDown.y)
  return moved <= QUICK_REACT_MAX_DISTANCE_PX
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }
  return null
}

/**
 * True when a non-whitespace glyph lies under the viewport point. Caret hit-testing snaps
 * to the nearest text position, so the glyph box on either side of the caret is tested
 * against the point itself. Without caret APIs, a non-empty selection stands in: the
 * browser selects a word on a double-click over text.
 */
export function isPointOverText(x: number, y: number): boolean {
  if (typeof document === 'undefined') return false
  const caret = caretAt(x, y)
  if (!caret) return (window.getSelection?.()?.toString().trim() ?? '') !== ''
  if (caret.node.nodeType !== Node.TEXT_NODE) return false
  const text = caret.node as Text
  const range = document.createRange()
  for (const i of [caret.offset - 1, caret.offset]) {
    if (i < 0 || i >= text.length || !/\S/.test(text.data[i])) continue
    range.setStart(text, i)
    range.setEnd(text, i + 1)
    for (const rect of Array.from(range.getClientRects())) {
      if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top && y <= rect.bottom) return true
    }
  }
  return false
}
