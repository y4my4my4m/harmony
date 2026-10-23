/**
 * Card-click pattern: a container that opens its item when clicked, while a real link inside
 * it is the keyboard path, and its links and controls keep their own clicks.
 */

/** Elements that act on a click themselves. `.mention` and `.hashtag` are rendered post content. */
const OWN_CLICK = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  'video',
  'audio',
  'iframe',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '.mention',
  '.hashtag',
].join(', ')

/**
 * True when a click on a card is not the card's: not the primary button, a modifier held, a
 * click a control inside the card already handled or acts on, or the end of a text selection
 * within the card. Call from the card's own click listener.
 */
export function cardClickIgnored(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return true
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true
  const card = event.currentTarget
  if (!(card instanceof Element)) return true
  const target = event.target
  if (target instanceof Element) {
    const own = target.closest(OWN_CLICK)
    if (own && own !== card && card.contains(own)) return true
  }
  const selection = typeof window !== 'undefined' ? window.getSelection?.() : null
  if (selection && !selection.isCollapsed && selection.anchorNode && card.contains(selection.anchorNode)) return true
  return false
}
