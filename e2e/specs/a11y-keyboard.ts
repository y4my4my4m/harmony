// Keyboard helpers for the accessibility journeys.

import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Presses Tab (or Shift+Tab) until `target` holds focus; fails when it is not
 * reached within `max` presses, i.e. it is not in the tab sequence.
 */
export async function tabTo(
  page: Page,
  target: Locator,
  options: { max?: number; backwards?: boolean } = {},
): Promise<void> {
  const max = options.max ?? 40
  await expect(target).toBeAttached()
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press(options.backwards ? 'Shift+Tab' : 'Tab')
  }
  await expect(target, `not reached within ${max} Tab presses`).toBeFocused()
}

/** True when focus sits inside the element matched by `selector`. */
export async function focusWithin(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    return !!root && !!document.activeElement && root.contains(document.activeElement)
  }, selector)
}

/** The text of the element(s) an element's aria-describedby points at. */
export async function describedByText(target: Locator): Promise<string> {
  return target.evaluate((el) =>
    (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim(),
  )
}

/** The polite live region; poll it, announcements are throttled. */
export const politeRegion = (page: Page) => page.getByTestId('live-announcer-polite')

/**
 * Keeps every text either live region shows from now on. A message replaced
 * within a poll interval (an upload that finishes as it is attached) never
 * reaches toHaveText; screen readers still queue it.
 */
export async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: string[] = []
    ;(window as unknown as { __announced: string[] }).__announced = log
    for (const id of ['live-announcer-polite', 'live-announcer-assertive']) {
      const region = document.querySelector(`[data-testid="${id}"]`)
      if (!region) continue
      new MutationObserver(() => {
        const text = region.textContent?.trim()
        if (text) log.push(text)
      }).observe(region, { childList: true, characterData: true, subtree: true })
    }
  })
}

/** Texts seen since recordAnnouncements. */
export const announced = (page: Page) =>
  page.evaluate(() => (window as unknown as { __announced?: string[] }).__announced ?? [])

/**
 * Waits until no CSS animation or transition is running: axe reads colours
 * mid-fade as blended and reports contrast that the settled page does not have.
 */
export async function animationsSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    undefined,
    { timeout: 5000 },
  )
}
