// Journey: a channel's notification entries from its context menu in the channel list.
//
// The menu carries the chat header's More options entries that act on a channel from the
// list: Mark as read, Mute channel (a submenu of durations) or Unmute, Notification level
// (a submenu of radio items) and Notification settings. They read and write the same
// store state as the header menu: a level set in the list shows checked in the header.
// Submenus open with ArrowRight, Enter or a tap and close with ArrowLeft or Escape;
// they expand in place, so the menu stays inside a phone's viewport. Opening and closing
// the menu leaves the channel list's layout as it was.
//
// The stack has no realtime: every write is read back from the database.

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let reader: SpecUser
let server: SeededServer
const channel = { random: '', news: '' }

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'cmno')
  reader = await createUser(admin, 'cmnr')
  server = await seedServer(admin, owner, `Channel Menu ${owner.username}`)
  await addMember(admin, reader, server.id)
  channel.random = await addChannel(admin, server, 'random')
  channel.news = await addChannel(admin, server, 'news')
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, reader)
})

const sidebar = (page: Page) => page.locator('nav[aria-label="Channels"]')
const channelLink = (page: Page, name: string) => sidebar(page).getByRole('link', { name: new RegExp(`^${name}\\s?,`) })
const channelMenu = (page: Page, name: string) => page.getByRole('menu', { name, exact: true })
const announcer = (page: Page) => page.getByTestId('live-announcer-polite')

async function override(channelId: string): Promise<{ notification_level: string | null; muted: boolean; muted_until: string | null } | null> {
  const { data } = await admin.from('notification_channels')
    .select('notification_level, muted, muted_until')
    .eq('user_id', reader.id)
    .eq('channel_id', channelId)
    .maybeSingle()
  return data
}

/** Box and look of every channel row: what a layout or style regression changes. */
async function listFingerprint(page: Page): Promise<unknown[]> {
  return sidebar(page).locator('.channel-item').evaluateAll((items) => items.map((el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const name = el.querySelector('.channel-name')
    const nameStyle = name ? getComputedStyle(name) : null
    return {
      text: name?.textContent,
      box: [box.x, box.y, box.width, box.height].map(Math.round),
      color: style.color,
      background: style.backgroundColor,
      opacity: style.opacity,
      font: nameStyle ? [nameStyle.fontSize, nameStyle.fontWeight, nameStyle.color] : null,
    }
  }))
}

async function openMenuFromKeyboard(page: Page, name: string): Promise<Locator> {
  await channelLink(page, name).focus()
  await page.keyboard.press('Shift+F10')
  const menu = channelMenu(page, name)
  await expect(menu).toBeVisible()
  return menu
}

test('notification level from the channel menu, by keyboard', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  const random = channelLink(page, 'random')
  await expect(random).toBeVisible({ timeout: 20000 })

  const before = await listFingerprint(page)
  const menu = await openMenuFromKeyboard(page, 'random')

  await test.step('the header\'s notification entries are menu items; two own a submenu', async () => {
    await expect(menu.getByRole('menuitem', { name: 'Mark as read' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Notification settings' })).toBeVisible()
    const mute = menu.getByRole('menuitem', { name: 'Mute channel', exact: true })
    await expect(mute).toHaveAttribute('aria-haspopup', 'menu')
    await expect(mute).toHaveAttribute('aria-expanded', 'false')
    const level = menu.getByRole('menuitem', { name: 'Notification level' })
    await expect(level).toHaveAttribute('aria-haspopup', 'menu')
    await expect(level).toHaveAttribute('aria-expanded', 'false')
  })

  const levelItem = menu.getByRole('menuitem', { name: 'Notification level' })
  const levels = page.getByRole('menu', { name: 'Notification level' })

  await test.step('ArrowRight opens the level submenu on its first radio; ArrowLeft closes it', async () => {
    await levelItem.focus()
    await page.keyboard.press('ArrowRight')
    await expect(levels).toBeVisible()
    await expect(levelItem).toHaveAttribute('aria-expanded', 'true')
    const radios = levels.getByRole('menuitemradio')
    await expect(radios).toHaveCount(4)
    await expect(radios.first()).toBeFocused()
    await expect(radios.first()).toHaveAttribute('aria-checked', 'true')
    await expect(levels.getByRole('menuitemradio', { checked: true })).toHaveCount(1)
    await page.keyboard.press('ArrowLeft')
    await expect(levels).toBeHidden()
    await expect(levelItem).toBeFocused()
    await expect(levelItem).toHaveAttribute('aria-expanded', 'false')
  })

  await test.step('Enter opens it too; Escape closes only the submenu', async () => {
    await page.keyboard.press('Enter')
    await expect(levels).toBeVisible()
    await expect(levels.getByRole('menuitemradio').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(levels).toBeHidden()
    await expect(menu).toBeVisible()
    await expect(levelItem).toBeFocused()
  })

  await test.step('choosing Nothing closes the menu on the channel row and saves the override', async () => {
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('End')
    await expect(levels.getByRole('menuitemradio', { name: 'Nothing' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(random).toBeFocused()
    await expect(announcer(page)).toHaveText('random: Nothing', { timeout: 10000 })
    await expect.poll(async () => (await override(channel.random))?.notification_level, { timeout: 15000 }).toBe('none')
  })

  await test.step('the channel menu and the header menu show the same level', async () => {
    const again = await openMenuFromKeyboard(page, 'random')
    await again.getByRole('menuitem', { name: 'Notification level' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(levels.getByRole('menuitemradio', { name: 'Nothing' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(again).toBeHidden()
    await expect(random).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${channel.random}`))
    await page.locator('.chat-header').getByRole('button', { name: 'More options' }).click()
    const header = page.getByRole('menu', { name: 'More options' })
    await expect(header.locator('[data-testid="channel-level-none"]')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(header).toBeHidden()
  })

  await test.step('the header menu\'s Default resets it; the channel menu follows', async () => {
    await page.locator('.chat-header').getByRole('button', { name: 'More options' }).click()
    await page.locator('[data-testid="channel-level-default"]').click()
    await expect.poll(async () => (await override(channel.random))?.notification_level ?? null, { timeout: 15000 }).toBe(null)
    const again = await openMenuFromKeyboard(page, 'random')
    await again.getByRole('menuitem', { name: 'Notification level' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(levels.getByRole('menuitemradio').first()).toHaveAttribute('aria-checked', 'true')
    await expect(levels.getByRole('menuitemradio', { checked: true })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(again).toBeHidden()
  })

  await test.step('the channel list kept its layout through the menu', async () => {
    await expect(channelMenu(page, 'random')).toBeHidden()
    // The current channel moved from #general to #random: compare all but colours.
    const after = await listFingerprint(page)
    const strip = (rows: unknown[]) => (rows as Array<{ box: number[]; text: string; font: string[] | null }>)
      .map(({ box, text, font }) => ({ box, text, font: font?.slice(0, 2) }))
    expect(strip(after)).toEqual(strip(before))
  })
})

test('mute for a duration from the channel menu, then unmute', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  const news = channelLink(page, 'news')
  await expect(news).toBeVisible({ timeout: 20000 })
  const before = await listFingerprint(page)

  await test.step('Mute channel opens its durations; For 1 hour mutes until an hour from now', async () => {
    const menu = await openMenuFromKeyboard(page, 'news')
    const mute = menu.getByRole('menuitem', { name: 'Mute channel', exact: true })
    await mute.focus()
    await page.keyboard.press('Enter')
    const durations = page.getByRole('menu', { name: 'Mute channel', exact: true })
    await expect(durations).toBeVisible()
    await expect(durations.getByRole('menuitem')).toHaveCount(6)
    await expect(durations.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(durations.getByRole('menuitem', { name: 'For 1 hour' })).toBeFocused()
    const startedAt = Date.now()
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(news).toBeFocused()
    await expect(news).toHaveAccessibleName(/, muted/)
    await expect.poll(async () => (await override(channel.news))?.muted, { timeout: 15000 }).toBe(true)
    const until = Date.parse((await override(channel.news))!.muted_until!)
    expect(until - startedAt).toBeGreaterThan(55 * 60_000)
    expect(until - startedAt).toBeLessThan(65 * 60_000)
  })

  await test.step('a muted channel offers Unmute, with the time the mute ends', async () => {
    const menu = await openMenuFromKeyboard(page, 'news')
    await expect(menu.getByRole('menuitem', { name: 'Mute channel', exact: true })).toHaveCount(0)
    await expect(menu).toContainText(/Muted until/)
    await menu.getByRole('menuitem', { name: 'Unmute channel', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(news).toBeFocused()
    await expect(news).not.toHaveAccessibleName(/, muted/)
    await expect.poll(async () => (await override(channel.news))?.muted ?? false, { timeout: 15000 }).toBe(false)
  })

  await test.step('back to where it started, the list looks as it did', async () => {
    await page.mouse.move(2, 2)
    expect(await listFingerprint(page)).toEqual(before)
  })
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('a long press opens the menu; the submenu expands inside the viewport', async ({ page }) => {
    test.setTimeout(150_000)
    await signIn(page, reader)
    await openChannel(page, server.id, server.generalChannelId)
    await page.getByRole('button', { name: 'Navigation menu' }).click()
    const random = channelLink(page, 'random')
    await expect(random).toBeInViewport({ timeout: 20000 })
    const box = (await random.boundingBox())!
    // A long press on Android fires contextmenu, a MouseEvent at the touch point.
    await random.evaluate((el, point) => el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: point.x, clientY: point.y,
    })), { x: box.x + 40, y: box.y + box.height / 2 })
    const menu = channelMenu(page, 'random')
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Mute channel', exact: true }).tap()
    const durations = page.getByRole('menu', { name: 'Mute channel', exact: true })
    await expect(durations).toBeVisible()
    const width = viewport.width
    for (const target of [menu, durations]) {
      const b = (await target.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(width)
    }
    await durations.getByRole('menuitem', { name: 'For 15 minutes' }).tap()
    await expect(menu).toBeHidden()
    await expect.poll(async () => (await override(channel.random))?.muted, { timeout: 15000 }).toBe(true)
  })
})
