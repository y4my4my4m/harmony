// Journey: on a 960×540 screen (a Fire TV Stick's Silk viewport) every part of sign-up and the
// profile step can be reached by scrolling the document, which is all Silk's d-pad pointer
// scrolls; on Fire TV the chat columns scroll when the pointer rests at their top or bottom
// edge, and take focus for the arrow keys. Other browsers get neither.
//
//   sign-up     /register and /new-profile grow past the screen instead of being clipped; the
//               profile header starts on screen; scrolled to the end, Continue is on screen
//               and takes a plain pointer click
//   Fire TV     the pointer in the top band of the message list scrolls it up, in its bottom
//               band down, and nowhere else; the list has tabindex 0
//   elsewhere   the same pointer moves nothing and no tabindex is added

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  PASSWORD,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const SCREEN = { width: 960, height: 540 }
/** Silk on a Fire TV Stick 4K (AFTMM), tablet view: Amazon's Silk template with the device's model. */
const FIRE_TV_UA =
  'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.4.1 like Chrome/120.0.6099.230 Safari/537.36'

const admin = adminClient()
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const USERNAME = `short${RUN}`.toLowerCase()
const EMAIL = `${USERNAME}@e2e.harmony.local`

test.use({ viewport: SCREEN })

async function scrollTo(page: Page, top: number) {
  await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), top)
}

async function documentScroll(page: Page) {
  return page.evaluate(() => ({
    height: document.scrollingElement!.scrollHeight,
    viewport: window.innerHeight,
    top: document.scrollingElement!.scrollTop,
  }))
}

/** The element is inside the viewport and is what a click at its centre lands on. */
async function expectOnScreenAndHit(page: Page, testId: string) {
  const hit = await page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { top: r.top, bottom: r.bottom, hit: !!at && (at === el || el.contains(at)) }
  })
  expect(hit.top).toBeGreaterThanOrEqual(0)
  expect(hit.bottom).toBeLessThanOrEqual(SCREEN.height)
  expect(hit.hit).toBe(true)
}

test.describe('sign-up on a short screen', () => {
  test.afterAll(async () => {
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    const user = data?.users?.find((u) => u.email === EMAIL)
    if (!user) return
    await admin.from('profiles').delete().eq('auth_user_id', user.id)
    await admin.auth.admin.deleteUser(user.id)
  })

  test('every part of /register and the profile step is reached by scrolling the document', async ({ page }) => {
    test.setTimeout(180_000)

    await test.step('/register grows past the screen and scrolls to its footer', async () => {
      await page.goto('/register')
      await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })
      const scroll = await documentScroll(page)
      expect(scroll.height).toBeGreaterThan(scroll.viewport)
      expect(await page.locator('.auth-wrapper').evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0)
      await scrollTo(page, 1e6)
      const footer = await page.locator('.auth-footer').evaluate((el) => el.getBoundingClientRect().bottom)
      expect(footer).toBeLessThanOrEqual(SCREEN.height)
      await scrollTo(page, 0)
    })

    await test.step('register', async () => {
      await page.getByTestId('auth-email').fill(EMAIL)
      await page.getByTestId('auth-password').fill(PASSWORD)
      await page.getByTestId('auth-submit').click()
      await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })
      await expect(page.getByTestId('new-profile-card')).toBeVisible({ timeout: 15000 })
    })

    await test.step('the profile step opens at its top and scrolls to Continue', async () => {
      expect(await page.locator('.np-header').evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0)
      const scroll = await documentScroll(page)
      expect(scroll.height).toBeGreaterThan(scroll.viewport)

      await page.getByTestId('profile-display-name').fill(`Short ${RUN}`)
      await page.getByTestId('profile-username').fill(USERNAME)
      await expect(page.getByTestId('username-available')).toBeVisible({ timeout: 15000 })

      await scrollTo(page, 1e6)
      expect((await documentScroll(page)).top).toBeGreaterThan(0)
      await expectOnScreenAndHit(page, 'profile-submit')
    })

    await test.step('a pointer click on Continue, without scrolling, creates the profile', async () => {
      const box = (await page.getByTestId('profile-submit').boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect(page).toHaveURL(/\/chat/, { timeout: 60000 })
    })
  })
})

test.describe('chat columns', () => {
  let owner: SpecUser
  let server: SeededServer

  test.beforeAll(async () => {
    owner = await createUser(admin, 'tvsc')
    server = await seedServer(admin, owner, `Edges ${owner.username.slice(-6)}`)
    const base = Date.now() - 60 * 60_000
    const rows = Array.from({ length: 40 }, (_, i) => ({
      channel_id: server.generalChannelId,
      user_id: owner.id,
      content: [{ type: 'text', text: `edge message ${i + 1}\nsecond line\nthird line` }],
      created_at: new Date(base + i * 60_000).toISOString(),
    }))
    const { error } = await admin.from('messages').insert(rows)
    if (error) throw new Error(`seed messages: ${error.message}`)
  })

  test.afterAll(async () => {
    await admin.from('servers').delete().eq('id', server?.id ?? '')
    await deleteUser(admin, owner)
  })

  const list = (page: Page) => page.locator('.message-display')
  const scrollTop = (page: Page) => list(page).evaluate((el) => el.scrollTop)

  async function openLongChannel(page: Page) {
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await dismissAnnouncements(page)
    await expect(page.getByText('edge message 40')).toBeVisible({ timeout: 30000 })
    const box = (await list(page).boundingBox())!
    const sizes = await list(page).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
    expect(sizes.scroll).toBeGreaterThan(sizes.client + 200)
    return box
  }

  test.describe('on Fire TV', () => {
    test.use({ userAgent: FIRE_TV_UA })

    test('the pointer at a column edge scrolls it, and the column takes focus', async ({ page }) => {
      test.setTimeout(120_000)
      const box = await openLongChannel(page)
      await expect(list(page)).toHaveAttribute('tabindex', '0')
      const x = box.x + box.width / 2

      const start = await scrollTop(page)
      await page.mouse.move(x, box.y + 8)
      await expect.poll(() => scrollTop(page), { timeout: 5000 }).toBeLessThan(start - 150)

      await page.mouse.move(x, box.y + box.height / 2)
      const resting = await scrollTop(page)
      await page.waitForTimeout(400)
      expect(await scrollTop(page)).toBe(resting)

      await page.mouse.move(x, box.y + box.height - 8)
      await expect.poll(() => scrollTop(page), { timeout: 5000 }).toBeGreaterThan(resting + 150)
    })
  })

  test('another browser gets no edge scrolling and no added tab stop', async ({ page }) => {
    test.setTimeout(120_000)
    const box = await openLongChannel(page)
    expect(await list(page).getAttribute('tabindex')).toBeNull()
    const start = await scrollTop(page)
    await page.mouse.move(box.x + box.width / 2, box.y + 8)
    await page.waitForTimeout(800)
    expect(await scrollTop(page)).toBe(start)
  })
})
