// Journey: Back (the Android back gesture is WebView history back) closes the topmost
// overlay on a phone and leaves the channel only once nothing is open: the channel drawer,
// message search, a thread panel and the image viewer each close on Back, the channel
// stays. A channel picked from the drawer takes the drawer's place in history, so Back
// from it returns to the channel before.
//
// On a desktop window Back has no overlay entries; changing channel closes the search
// modal that belonged to the channel left behind.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let server: SeededServer
let sideId = ''
let imageId = ''

const imageUrl = new URL('/default_avatar.webp', process.env.BASE_URL || 'http://localhost:5173').href

test.beforeAll(async () => {
  me = await createUser(admin, 'mbk')
  server = await seedServer(admin, me, `Back ${me.username}`)
  sideId = await addChannel(admin, server, 'side')
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const text = (t: string) => [{ type: 'text', text: t }]

  const { data: image, error: imageError } = await admin
    .from('messages')
    .insert({
      channel_id: server.generalChannelId,
      user_id: me.id,
      content: [
        { type: 'text', text: 'a picture to open' },
        { type: 'file', url: imageUrl, fileType: 'image', mimeType: 'image/webp', fileName: 'avatar.webp' },
      ],
      created_at: at(30),
    })
    .select('id')
    .single()
  if (imageError) throw new Error(`image message: ${imageError.message}`)
  imageId = image!.id

  const client = await userClient(me)
  const { data: threadId, error: threadError } = await client.rpc('create_channel_thread', {
    p_channel_id: server.generalChannelId,
    p_name: 'Back thread',
  })
  if (threadError) throw new Error(`thread: ${threadError.message}`)
  const { error: replyError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    thread_id: threadId,
    user_id: me.id,
    content: text('a reply in the thread'),
    created_at: at(20),
  })
  if (replyError) throw new Error(`thread reply: ${replyError.message}`)

  const { error: newestError } = await admin.from('messages').insert([
    { channel_id: server.generalChannelId, user_id: me.id, content: text('newest in general'), created_at: at(1) },
    { channel_id: sideId, user_id: me.id, content: text('newest in side'), created_at: at(1) },
  ])
  if (newestError) throw new Error(`messages: ${newestError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, me)
})

// The channel's own name: its row also holds the thread under it.
const generalRow = (page: Page) => page.locator('.channel-sidebar .channel-name').getByText('general', { exact: true })

const onChannel = (page: Page, channelId: string) => expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${channelId}`))

async function backAndSettle(page: Page) {
  await page.goBack()
  await page.waitForTimeout(400)
}

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  async function openGeneralFromSide(page: Page) {
    await signIn(page, me)
    await page.goto(`/chat/${server.id}/${sideId}`)
    await dismissAnnouncements(page)
    await expect(messageList(page).getByText('newest in side')).toBeVisible({ timeout: 30000 })
    await page.getByRole('button', { name: 'Navigation menu' }).first().tap()
    await generalRow(page).tap()
    await expect(messageList(page).getByText('newest in general')).toBeVisible({ timeout: 30000 })
    await onChannel(page, server.generalChannelId)
  }

  test('Back closes the drawer, search, a thread and the image viewer before leaving the channel', async ({ page }) => {
    test.setTimeout(180_000)
    const layout = page.locator('.base-layout')
    await openGeneralFromSide(page)

    await test.step('the channel drawer', async () => {
      await page.getByRole('button', { name: 'Navigation menu' }).first().tap()
      await expect(layout).toHaveClass(/sidebar-open/)
      await backAndSettle(page)
      await expect(layout).not.toHaveClass(/sidebar-open/)
      await onChannel(page, server.generalChannelId)
    })

    await test.step('message search', async () => {
      await page.locator('.chat-header').getByRole('button', { name: 'Search messages' }).tap()
      const search = page.locator('.message-search-modal')
      await expect(search).toBeVisible()
      await backAndSettle(page)
      await expect(search).toBeHidden()
      await onChannel(page, server.generalChannelId)
    })

    await test.step('a thread panel', async () => {
      await page.getByRole('button', { name: 'More options' }).first().tap()
      await page.getByRole('menuitem', { name: /threads/i }).tap()
      await page.locator('.threads-modal').getByText('Back thread').first().tap()
      const panel = page.locator('.thread-panel')
      await expect(panel).toBeVisible()
      await expect(panel.getByText('a reply in the thread')).toBeVisible({ timeout: 15000 })
      await backAndSettle(page)
      await expect(panel).toBeHidden()
      await onChannel(page, server.generalChannelId)
    })

    await test.step('the image viewer', async () => {
      const row = messageList(page).locator(`[data-message-id="${imageId}"]`)
      await row.scrollIntoViewIfNeeded()
      await row.locator('img').last().tap()
      const viewer = page.locator('.media-lightbox-dialog')
      await expect(viewer).toBeVisible()
      await backAndSettle(page)
      await expect(viewer).toBeHidden()
      await onChannel(page, server.generalChannelId)
    })

    await test.step('with nothing open, Back returns to the channel before', async () => {
      await backAndSettle(page)
      await onChannel(page, sideId)
    })
  })

  test('a channel picked from the drawer takes the drawer\'s place in history', async ({ page }) => {
    test.setTimeout(120_000)
    await openGeneralFromSide(page)
    await expect(page.locator('.base-layout')).not.toHaveClass(/sidebar-open/)
    await backAndSettle(page)
    await onChannel(page, sideId)
    await expect(messageList(page).getByText('newest in side')).toBeVisible({ timeout: 30000 })
  })

  test('an overlay closed by its own button leaves no extra Back step', async ({ page }) => {
    test.setTimeout(120_000)
    await openGeneralFromSide(page)
    await page.locator('.chat-header').getByRole('button', { name: 'Search messages' }).tap()
    const search = page.locator('.message-search-modal')
    await expect(search).toBeVisible()
    await search.locator('.search-close').tap()
    await expect(search).toBeHidden()
    await page.waitForTimeout(400)
    await backAndSettle(page)
    await onChannel(page, sideId)
  })
})

test.describe('on a desktop window', () => {
  test('changing channel closes the search of the channel left behind', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, me)
    await page.goto(`/chat/${server.id}/${sideId}`)
    await dismissAnnouncements(page)
    await expect(messageList(page).getByText('newest in side')).toBeVisible({ timeout: 30000 })
    await generalRow(page).click()
    await expect(messageList(page).getByText('newest in general')).toBeVisible({ timeout: 30000 })

    await page.locator('.chat-header').getByRole('button', { name: 'Search messages' }).click()
    const search = page.locator('.message-search-modal')
    await expect(search).toBeVisible()
    await page.goBack()
    await onChannel(page, sideId)
    await expect(search).toBeHidden()
  })
})
