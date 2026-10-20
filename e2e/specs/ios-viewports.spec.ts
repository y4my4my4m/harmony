// Journey: the chat shell in WebKit at iPhone, iPad and foldable-iPhone sizes, the
// engine of the iOS app (WKWebView) and of every iOS browser.
// - The shell keeps out of the safe-area insets at every width: status bar, home
//   indicator, and the notch side in landscape.
// - With the keyboard up the shell ends at the keyboard and the header stays on screen.
// - Resizing the window reflows the layout without a reload: iPad Split View and Slide
//   Over, a foldable unfolding, a rotation. A composer draft survives each resize.
//
// WebKit outside iOS reports zero insets and has no software keyboard. The spec writes
// the variables the page derives from them: --safe-* (env(safe-area-inset-*)) and
// --keyboard-inset with --shell-safe-bottom (src/utils/iosKeyboard.ts, from
// visualViewport). Insets are those of an iPhone 15 Pro and an 11-inch iPad Air.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  adminClient,
  channelRow,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  me = await createUser(admin, 'ios')
  server = await seedServer(admin, me, `iOS ${me.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: me.id,
    content: [{ type: 'text', text: 'hello from a small screen' }],
  })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, me)
})

interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

async function setInsets(page: Page, insets: Insets): Promise<void> {
  await page.evaluate((i) => {
    const s = document.documentElement.style
    for (const side of ['top', 'right', 'bottom', 'left'] as const) s.setProperty(`--safe-${side}`, `${i[side]}px`)
  }, insets)
}

async function setKeyboard(page: Page, height: number): Promise<void> {
  await page.evaluate((h) => {
    const s = document.documentElement.style
    if (h > 0) {
      s.setProperty('--keyboard-inset', `${h}px`)
      s.setProperty('--shell-safe-bottom', '0px')
    } else {
      s.removeProperty('--keyboard-inset')
      s.removeProperty('--shell-safe-bottom')
    }
  }, height)
}

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`${selector} has no box`)
  return b
}

/** Shell geometry against the viewport and the insets, after the layout settles. */
async function expectShellInside(page: Page, insets: Insets, keyboard = 0): Promise<void> {
  const { width, height } = page.viewportSize()!
  const bottomEdge = keyboard > 0 ? height - keyboard : height - insets.bottom
  await expect
    .poll(async () => {
      const shell = await box(page, '.base-layout')
      return Math.round(shell.height)
    }, { message: 'the shell spans the viewport less the keyboard' })
    .toBe(keyboard > 0 ? height - keyboard : height)
  // The content column holds the context bar on wide layouts and the channel header on phones.
  const content = await box(page, '.content-area')
  const header = await box(page, '.chat-header-container')
  const input = await box(page, '[data-testid="message-input"]')
  const list = await box(page, '[data-testid="message-list"]')
  expect(content.y, 'content below the status bar').toBeGreaterThanOrEqual(insets.top - 0.5)
  expect(content.y + content.height, 'content above the home indicator or keyboard').toBeLessThanOrEqual(bottomEdge + 0.5)
  expect(header.y, 'channel header on screen').toBeGreaterThanOrEqual(insets.top - 0.5)
  expect(input.y + input.height, 'composer above the home indicator or keyboard').toBeLessThanOrEqual(bottomEdge + 0.5)
  expect(list.x + list.width, 'messages clear of the right inset').toBeLessThanOrEqual(width - insets.right + 0.5)
  if (width > 768) {
    // The rail is in the flow on wide layouts; on phones it is a drawer that pads itself.
    const rail = await box(page, '.server-sidebar-container')
    expect(rail.y, 'server rail below the status bar').toBeGreaterThanOrEqual(insets.top - 0.5)
    expect(rail.x, 'server rail clear of the left inset').toBeGreaterThanOrEqual(insets.left - 0.5)
    const profile = await box(page, '.user-profile-section')
    expect(profile.x, 'user panel clear of the left inset').toBeGreaterThanOrEqual(insets.left - 0.5)
    expect(profile.y + profile.height, 'user panel above the home indicator').toBeLessThanOrEqual(bottomEdge + 0.5)
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0)
}

/** Desktop layout (wider than 768px) shows the channel list; the phone layout hides it in a drawer. */
async function expectLayout(page: Page, mode: 'desktop' | 'phone'): Promise<void> {
  const general = channelRow(page, 'general')
  if (mode === 'desktop') await expect(general).toBeInViewport({ timeout: 10000 })
  else await expect(general).not.toBeInViewport({ timeout: 10000 })
}

async function resize(page: Page, width: number, height: number, insets: Insets): Promise<void> {
  await page.setViewportSize({ width, height })
  await setInsets(page, insets)
}

test.describe('iPhone', () => {
  const { userAgent } = devices['iPhone 15 Pro']
  test.use({ viewport: { width: 393, height: 852 }, userAgent, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

  test('portrait and landscape keep the shell inside the safe area; the keyboard shortens it', async ({ page }) => {
    test.setTimeout(150_000)
    await signIn(page, me)
    await openChannel(page, server.id, server.generalChannelId)
    await expect(messageList(page).getByText('hello from a small screen')).toBeVisible({ timeout: 30000 })

    const portrait: Insets = { top: 59, right: 0, bottom: 34, left: 0 }
    await test.step('portrait: below the Dynamic Island, above the home indicator', async () => {
      await setInsets(page, portrait)
      await expectLayout(page, 'phone')
      await expectShellInside(page, portrait)
    })

    await test.step('the keyboard: the composer sits on it and the header stays', async () => {
      await composer(page).tap()
      await composer(page).pressSequentially('typing over the keyboard', { delay: 5 })
      await setKeyboard(page, 336)
      await expectShellInside(page, portrait, 336)
      await expect(composer(page)).toBeFocused()
      await setKeyboard(page, 0)
      await expectShellInside(page, portrait)
    })

    await test.step('landscape: clear of the notch side and the home indicator', async () => {
      const landscape: Insets = { top: 0, right: 59, bottom: 21, left: 59 }
      await resize(page, 852, 393, landscape)
      await expectLayout(page, 'desktop')
      await expectShellInside(page, landscape)
      await expect(composer(page)).toContainText('typing over the keyboard')
    })
  })
})

test.describe('iPad', () => {
  // iPadOS Safari and WKWebView send the Mac user agent; touch points tell them apart.
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  test.use({ viewport: { width: 1180, height: 820 }, userAgent, deviceScaleFactor: 2, hasTouch: true })

  test('full screen, Split View and Slide Over reflow without a reload', async ({ page }) => {
    test.setTimeout(150_000)
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 })
    })
    await signIn(page, me)
    await openChannel(page, server.id, server.generalChannelId)
    const ipad: Insets = { top: 24, right: 0, bottom: 20, left: 0 }

    await test.step('landscape, full screen: the desktop layout under the status bar', async () => {
      await setInsets(page, ipad)
      await expectLayout(page, 'desktop')
      await expectShellInside(page, ipad)
      await composer(page).click()
      await composer(page).pressSequentially('draft across window sizes', { delay: 5 })
    })

    await test.step('half of Split View: the phone layout', async () => {
      await resize(page, 590, 820, ipad)
      await expectLayout(page, 'phone')
      await expectShellInside(page, ipad)
    })

    await test.step('Slide Over width: still no horizontal scroll', async () => {
      await resize(page, 320, 820, ipad)
      await expectLayout(page, 'phone')
      await expectShellInside(page, ipad)
    })

    await test.step('back to full screen, then portrait', async () => {
      await resize(page, 1180, 820, ipad)
      await expectLayout(page, 'desktop')
      await expectShellInside(page, ipad)
      await resize(page, 820, 1180, ipad)
      await expectLayout(page, 'desktop')
      await expectShellInside(page, ipad)
      await expect(composer(page)).toContainText('draft across window sizes')
    })
  })
})

test.describe('foldable iPhone', () => {
  // Cover screen iPhone-sized, inner screen near-square at about 4:3. Representative sizes.
  const { userAgent } = devices['iPhone 15 Pro']
  test.use({ viewport: { width: 375, height: 812 }, userAgent, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

  test('unfolding and rotating reflow the open channel', async ({ page }) => {
    test.setTimeout(150_000)
    await signIn(page, me)
    await openChannel(page, server.id, server.generalChannelId)
    const cover: Insets = { top: 47, right: 0, bottom: 34, left: 0 }

    await test.step('folded: the phone layout', async () => {
      await setInsets(page, cover)
      await expectLayout(page, 'phone')
      await expectShellInside(page, cover)
      await composer(page).tap()
      await composer(page).pressSequentially('draft before unfolding', { delay: 5 })
    })

    await test.step('unfolded, landscape: the desktop layout', async () => {
      const inner: Insets = { top: 24, right: 0, bottom: 20, left: 0 }
      await resize(page, 904, 640, inner)
      await expectLayout(page, 'desktop')
      await expectShellInside(page, inner)
      await expect(messageList(page).getByText('hello from a small screen')).toBeVisible()
    })

    await test.step('unfolded, portrait: the phone layout', async () => {
      const inner: Insets = { top: 24, right: 0, bottom: 20, left: 0 }
      await resize(page, 640, 904, inner)
      await expectLayout(page, 'phone')
      await expectShellInside(page, inner)
      await expect(composer(page)).toContainText('draft before unfolding')
    })

    await test.step('folded again', async () => {
      await resize(page, 375, 812, cover)
      await expectLayout(page, 'phone')
      await expectShellInside(page, cover)
    })
  })
})
