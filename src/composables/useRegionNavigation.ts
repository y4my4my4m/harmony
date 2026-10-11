/**
 * F6 / Shift+F6 move focus between the page's landmark regions (servers,
 * channels, main, members, voice connection, user panel), in document order,
 * wrapping. Ctrl+F6 / Ctrl+Shift+F6 do the same for browsers that keep F6 for
 * their address bar. Installed once, in BaseLayout.
 *
 * Regions are landmarks (nav, main, aside, header, footer, labelled
 * section/role=region, and their ARIA roles) that are visible, not inert, not
 * inside a dialog, and not nested in another region. Landing in a region
 * focuses its [aria-current] item (the current server or channel), else the
 * region element itself (tabindex="-1"), which reads its label.
 *
 * Inactive while a dialog is open: the dialog keeps focus.
 */

import { onBeforeUnmount, onMounted } from 'vue'
import { focusElement, focusProgrammatically, isVisibleForFocus } from '@/utils/a11y/focus'
import { hasOpenLayer } from '@/utils/a11y/layers'

const LANDMARK_SELECTOR = [
  'nav',
  'main',
  'aside',
  'header',
  'footer',
  'section[aria-label]',
  'section[aria-labelledby]',
  '[role="navigation"]',
  '[role="main"]',
  '[role="complementary"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[role="region"][aria-label]',
  '[role="region"][aria-labelledby]',
].join(',')

const SECTIONING = 'article, aside, main, nav, section, [role="dialog"], [role="alertdialog"]'

function isLandmark(el: Element): boolean {
  const tag = el.tagName
  // header/footer are landmarks only outside sectioning content (HTML-AAM).
  if ((tag === 'HEADER' || tag === 'FOOTER') && !el.hasAttribute('role')) {
    return !el.parentElement?.closest(SECTIONING)
  }
  return true
}

/** Top-level landmark regions in document order. */
export function landmarkRegions(root: ParentNode = document): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(LANDMARK_SELECTOR)).filter(
    (el) => isLandmark(el) && isVisibleForFocus(el) && !el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
  )
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)))
}

/** Moves focus to the next (+1) or previous (-1) region; false when there is none. */
export function moveToRegion(direction: 1 | -1, root: ParentNode = document): boolean {
  const regions = landmarkRegions(root)
  if (regions.length === 0) return false
  const active = document.activeElement
  const current = regions.findIndex((r) => active instanceof Node && r.contains(active))
  const next = current < 0 ? (direction === 1 ? 0 : regions.length - 1) : (current + direction + regions.length) % regions.length
  const region = regions[next]
  const currentItem = region.querySelector<HTMLElement>('[aria-current]:not([aria-current="false"])')
  if (currentItem && isVisibleForFocus(currentItem) && focusElement(currentItem)) return true
  region.setAttribute('data-region-focus', '')
  return focusProgrammatically(region)
}

export function useRegionNavigation(): void {
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'F6' || event.altKey || event.metaKey || event.defaultPrevented) return
    if (hasOpenLayer('dialog')) return
    event.preventDefault()
    moveToRegion(event.shiftKey ? -1 : 1)
  }
  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
