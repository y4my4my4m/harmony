// Journey: the box that edits a message draws its text at the message text's computed font size
// and line height: at the default size, at a chat font size and zoom set in Appearance, and on a
// phone. The box drew 14 px under 15 px message text.

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let plain: SpecUser
let large: SpecUser
let plainServer: SeededServer
let largeServer: SeededServer

async function seed(server: SeededServer, author: SpecUser, text: string): Promise<void> {
  const { error } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: author.id, content: [{ type: 'text', text }] })
  if (error) throw new Error(`message: ${error.message}`)
}

test.beforeAll(async () => {
  plain = await createUser(admin, 'efsplain')
  large = await createUser(admin, 'efslarge')
  plainServer = await seedServer(admin, plain, `Edit size ${plain.username.slice(-6)}`)
  largeServer = await seedServer(admin, large, `Edit size ${large.username.slice(-6)}`)
  const { error } = await admin
    .from('profiles')
    .update({ appearance_settings: { fontSize: 19, zoomLevel: 125 } })
    .eq('id', large.id)
  if (error) throw new Error(`appearance: ${error.message}`)
  for (const [server, author] of [[plainServer, plain], [largeServer, large]] as const) {
    await seed(server, author, `size check ${author.username}`)
    await seed(server, author, `neighbour line ${author.username}`)
  }
})

test.afterAll(async () => {
  await deleteUser(admin, plain)
  await deleteUser(admin, large)
})

const row = (page: Page, text: string) =>
  page.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })

const metrics = (locator: Locator) =>
  locator.evaluate((el) => {
    const style = getComputedStyle(el)
    return { fontSize: style.fontSize, lineHeight: style.lineHeight }
  })

/** The edited message's text metrics, then its edit box's. */
async function compare(page: Page, user: SpecUser, open: (r: Locator) => Promise<void>) {
  const text = `size check ${user.username}`
  const r = row(page, text)
  await expect(r).toBeVisible({ timeout: 30000 })
  const body = await metrics(r.locator('.text-content').first())
  await open(r)
  const editor = r.getByRole('textbox', { name: 'Edit message' })
  await expect(editor).toBeFocused({ timeout: 5000 })
  const neighbour = await metrics(row(page, `neighbour line ${user.username}`).locator('.text-content').first())
  return { body, neighbour, edit: await metrics(editor) }
}

const openByHover = async (r: Locator) => {
  await r.hover()
  await r.getByTestId('msg-action-edit').click()
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('at the default size the edit box matches the message text', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, plain)
    await openChannel(page, plainServer.id, plainServer.generalChannelId)
    const { body, neighbour, edit } = await compare(page, plain, openByHover)
    expect(body).toEqual({ fontSize: '15px', lineHeight: '20.625px' })
    expect(neighbour).toEqual(body)
    expect(edit).toEqual(body)
  })

  test('with a 19 px chat font and 125% zoom the edit box follows', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, large)
    await openChannel(page, largeServer.id, largeServer.generalChannelId)
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--message-font-size').trim()), { timeout: 15000 })
      .toBe('19px')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe('1.25')
    const { body, edit } = await compare(page, large, openByHover)
    expect(body.fontSize).toBe('19px')
    expect(edit).toEqual(body)
  })
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('on a phone the edit box matches the message text', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, plain)
    await page.goto(`/chat/${plainServer.id}/${plainServer.generalChannelId}`)
    await dismissAnnouncements(page)
    const { body, edit } = await compare(page, plain, async (r) => {
      const words = r.getByText(`size check ${plain.username}`)
      const b = (await words.boundingBox())!
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.synthesizeTapGesture', { x: b.x + 30, y: b.y + b.height / 2, duration: 900, tapCount: 1, gestureSourceType: 'touch' })
      const bar = page.getByRole('toolbar', { name: 'Message actions' })
      await expect(bar).toBeVisible({ timeout: 5000 })
      await bar.getByTestId('msg-action-edit').tap()
    })
    expect(edit).toEqual(body)
  })
})
