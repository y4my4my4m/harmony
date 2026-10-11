/**
 * Arrow-key focus movement for a role="tablist" (WAI-ARIA tabs pattern, manual
 * activation): Left/Right move focus with wrap, Home/End go to the ends, and
 * Enter or Space on the focused tab activates it through its click handler. The
 * selected tab carries tabindex="0" and the others "-1" in the template.
 *
 *   <div role="tablist" :aria-label="..." @keydown="tablistKeydown">
 *     <button role="tab" :id :aria-selected :aria-controls :tabindex>...</button>
 */
export function tablistKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const list = event.currentTarget as HTMLElement | null
  if (!list) return
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (el) => !el.matches('[disabled], [aria-disabled="true"]'),
  )
  const index = tabs.indexOf(document.activeElement as HTMLElement)
  if (index === -1) return
  event.preventDefault()
  const rtl = getComputedStyle(list).direction === 'rtl'
  const forward = (event.key === 'ArrowRight') !== rtl
  let next = index
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    next = (index + (forward ? 1 : -1) + tabs.length) % tabs.length
  }
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = tabs.length - 1
  tabs[next]?.focus()
}
