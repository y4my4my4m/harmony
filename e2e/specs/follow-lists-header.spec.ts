// Journey: the Followers / Following / Requests page. Its tab bar is the visible header: every
// tab's label and count fit in the column, untruncated, on a desktop window (where the social
// column is narrower than the window) and on a phone. Stuck while the list scrolls, the header
// meets the column's top edge, its tabs whole. The page keeps its h1 for screen readers.

import { test, expect, devices, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, userClient, type SpecUser } from './harness'

const admin = adminClient()
let me: SpecUser
let other: SpecUser

test.beforeAll(async () => {
  me = await createUser(admin, 'flhdr')
  other = await createUser(admin, 'flhdo')
  const { error } = await (await userClient(me)).from('follows').insert({ follower_id: me.id, following_id: other.id, status: 'accepted' })
  if (error) throw new Error(`follow: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, other)
  await deleteUser(admin, me)
})

async function expectTabsFit(page: Page) {
  const tablist = page.getByRole('tablist')
  await expect(page.getByTestId('follow-tab-following')).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('follow-tab-following')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { level: 1, name: 'Following' })).toBeAttached()
  const fit = await tablist.evaluate((list) => {
    // The page's scroll column, which clips anything past its edge.
    const column = (list.closest('.followers-view') ?? list).getBoundingClientRect()
    return [...list.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => {
      const r = tab.getBoundingClientRect()
      const label = tab.querySelector<HTMLElement>('.toggle-label')
      return {
        id: tab.id,
        inside: r.left >= column.left - 0.5 && r.right <= column.right + 0.5,
        whole: tab.scrollWidth <= tab.clientWidth && (!label || label.scrollWidth <= label.clientWidth),
      }
    })
  })
  expect(fit.map((tab) => tab.id)).toEqual(['follow-tab-followers', 'follow-tab-following', 'follow-tab-requests'])
  for (const tab of fit) expect(tab, tab.id).toEqual({ id: tab.id, inside: true, whole: true })
}

// Sticky insets count from inside the scrolling column's padding: top equal to minus that
// padding puts the stuck header on the column's edge (Chromium and Firefox, measured 2026-10-29).
async function expectHeaderFlushWhenStuck(page: Page) {
  const placement = await page.locator('.followers-view').evaluate((column) => {
    const spacer = document.createElement('div')
    spacer.style.cssText = 'height:3000px;flex:none'
    column.appendChild(spacer)
    column.scrollTop = 400
    const edge = column.getBoundingClientRect().top
    const header = column.querySelector('.view-header')!.getBoundingClientRect().top - edge
    const tabs = column.querySelector('[role="tablist"]')!.getBoundingClientRect().top - edge
    const scrolled = column.scrollTop
    spacer.remove()
    return { header, tabs, scrolled }
  })
  expect(placement.scrolled).toBeGreaterThan(0)
  expect(Math.abs(placement.header)).toBeLessThan(1)
  expect(placement.tabs).toBeGreaterThanOrEqual(0)
}

test('desktop: every tab fits the social column, label and count whole', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1100, height: 700 })
  await signIn(page, me)
  await page.goto('/social/following')
  await expectTabsFit(page)
  await expectHeaderFlushWhenStuck(page)
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('every tab fits the screen, label and count whole', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, me)
    await page.goto('/social/following')
    await expectTabsFit(page)
    await expectHeaderFlushWhenStuck(page)
  })
})
