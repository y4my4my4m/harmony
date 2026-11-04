// Journey: Drive's navigation is the app's left drawer panel, as the channel list is in a server.
//
// On a phone the hamburger and an edge swipe open the server rail and the Drive navigation
// together over the app's backdrop; Back, the backdrop and a pick close it, and a place picked
// from it takes the drawer's place in history; the open drawer paints its own panel in Lattice,
// Skyglass and Paper. Across the app's mobile breakpoint (768 px) Drive
// shows the hamburger exactly where the channel view does, and on a desktop window its
// navigation is a column as wide as the channel list.

import { test, expect, devices, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let me: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  me = await createUser(admin, 'drvd')
  server = await seedServer(admin, me, `Drawer ${me.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, me)
})

const layout = (page: Page) => page.locator('.base-layout')
const panel = (page: Page) => page.getByTestId('drive-sidebar')
const rail = (page: Page) => page.locator('#app-server-rail')
const hamburger = (page: Page) => page.getByTestId('drive-view').locator('.drive-view__nav-toggle')

async function openDrive(page: Page, path = '/drive') {
  await page.goto(path)
  await dismissAnnouncements(page)
  await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30000 })
}

/** Left edge of the element, px; settles after the drawer transition. */
async function leftEdge(page: Page, locator: ReturnType<Page['locator']>): Promise<number> {
  await page.waitForTimeout(450)
  return (await locator.boundingBox())!.x
}

async function backAndSettle(page: Page) {
  await page.goBack()
  await page.waitForTimeout(400)
}

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('the hamburger opens the server rail with the Drive navigation; Back, the backdrop and a pick close it', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, me)
    await openDrive(page)

    await test.step('the hamburger opens rail and navigation as one drawer over the backdrop', async () => {
      await expect(layout(page)).not.toHaveClass(/sidebar-open/)
      await hamburger(page).tap()
      await expect(layout(page)).toHaveClass(/sidebar-open/)
      await expect(page.locator('.mobile-overlay')).toBeVisible()
      expect(await leftEdge(page, rail(page))).toBe(0)
      expect(await leftEdge(page, panel(page))).toBe(72)
      await expect(panel(page).getByTestId('drive-nav-trash')).toBeVisible()
      await expect(rail(page).getByTestId('rail-drive')).toBeVisible()
      await expect(hamburger(page)).toHaveAccessibleName('Navigation menu')
      await expect(hamburger(page)).toHaveAttribute('aria-expanded', 'true')
      expect((await hamburger(page).getAttribute('aria-controls'))?.split(' ').sort()).toEqual(['app-drive-panel', 'app-server-rail'])
    })

    await test.step('Back closes it and stays in Drive', async () => {
      await backAndSettle(page)
      await expect(layout(page)).not.toHaveClass(/sidebar-open/)
      await expect(page).toHaveURL(/\/drive$/)
      expect(await leftEdge(page, panel(page))).toBeLessThan(0)
    })

    await test.step('a place picked from it closes it and takes its place in history', async () => {
      await hamburger(page).tap()
      await expect(layout(page)).toHaveClass(/sidebar-open/)
      await panel(page).getByTestId('drive-nav-trash').tap()
      await expect(page).toHaveURL(/\/drive\/trash$/)
      await expect(layout(page)).not.toHaveClass(/sidebar-open/)
      await backAndSettle(page)
      await expect(page).toHaveURL(/\/drive$/)
      await expect(layout(page)).not.toHaveClass(/sidebar-open/)
    })

    await test.step('the backdrop closes it', async () => {
      await hamburger(page).tap()
      await expect(layout(page)).toHaveClass(/sidebar-open/)
      await page.locator('.mobile-overlay').tap({ position: { x: 380, y: 400 } })
      await expect(layout(page)).not.toHaveClass(/sidebar-open/)
      await expect(page).toHaveURL(/\/drive$/)
    })

    await test.step('a swipe from the left edge opens both, the navigation following the finger', async () => {
      const cdp = await page.context().newCDPSession(page)
      const y = 420
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 4, y, id: 0 }] })
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 4 + i * 20, y, id: 0 }] })
      }
      const midway = (await panel(page).boundingBox())!.x
      expect(midway).toBeGreaterThan(-300)
      expect(midway).toBeLessThan(72)
      for (let i = 7; i <= 15; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 4 + i * 20, y, id: 0 }] })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await cdp.detach()
      await expect(layout(page)).toHaveClass(/sidebar-open/)
      expect(await leftEdge(page, panel(page))).toBe(72)
      await backAndSettle(page)
      await expect(layout(page)).not.toHaveClass(/sidebar-open/)
    })
  })

  // A drawer over the files paints its own panel in every skin.
  for (const skin of ['lattice', 'skyglass', 'paper']) {
    test(`the open drawer is opaque in ${skin}`, async ({ page }) => {
      test.setTimeout(90_000)
      const viewer = await createUser(admin, 'drvs')
      try {
        await admin.from('profiles').update({ appearance_settings: { theme: 'dark', activeSkinId: skin } }).eq('id', viewer.id)
        await signIn(page, viewer)
        await openDrive(page)
        await expect(page.locator('html')).toHaveAttribute('data-skin', skin, { timeout: 15000 })
        await hamburger(page).tap()
        await expect(layout(page)).toHaveClass(/sidebar-open/)
        const paint = await panel(page).evaluate((el) => {
          const style = getComputedStyle(el)
          return { color: style.backgroundColor, image: style.backgroundImage }
        })
        expect(paint.color !== 'rgba(0, 0, 0, 0)' || paint.image !== 'none', JSON.stringify(paint)).toBe(true)
      } finally {
        await deleteUser(admin, viewer)
      }
    })
  }
})

test('the Drive navigation follows the channel list across widths', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, me)

  await test.step('desktop: a column as wide as the channel list, no hamburger', async () => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    const channels = page.locator('#app-channel-panel')
    await expect(channels).toBeVisible({ timeout: 30000 })
    const channelWidth = (await channels.boundingBox())!.width
    await openDrive(page)
    const box = (await panel(page).boundingBox())!
    expect(box.x).toBe(72)
    expect(box.width).toBe(channelWidth)
    await expect(hamburger(page)).toHaveCount(0)
  })

  await test.step('at 765 px, the app\'s mobile layout, a drawer behind the hamburger as in a channel', async () => {
    await page.setViewportSize({ width: 765, height: 800 })
    await expect(hamburger(page)).toBeVisible()
    expect(await leftEdge(page, panel(page))).toBeLessThan(0)
    await hamburger(page).click()
    await expect(layout(page)).toHaveClass(/sidebar-open/)
    expect(await leftEdge(page, panel(page))).toBe(72)
    await page.keyboard.press('Escape')
    await expect(layout(page)).not.toHaveClass(/sidebar-open/)
  })
})
