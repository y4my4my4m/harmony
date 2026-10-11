// Focus target after a settings view switches section: the section's first
// heading (tabindex="-1"), so screen readers read where the user landed and
// Tab continues inside the section.
//
// Sections that fetch before rendering mount their heading a few frames late;
// the lookup retries for MAX_FRAMES animation frames.

import { focusProgrammatically, isVisibleForFocus } from './focus'

const HEADING_SELECTOR = 'h1, h2'
const MAX_FRAMES = 30

function findHeading(container: HTMLElement): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).find(isVisibleForFocus) ?? null
}

/** Focuses the first visible h1/h2 inside `container`; resolves true when one took focus. */
export function focusSectionHeading(container: HTMLElement | null | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (!container) return resolve(false)
    let frames = 0
    const attempt = () => {
      const heading = container.isConnected ? findHeading(container) : null
      if (heading) return resolve(focusProgrammatically(heading))
      if (++frames >= MAX_FRAMES || !container.isConnected) return resolve(false)
      requestAnimationFrame(attempt)
    }
    attempt()
  })
}
