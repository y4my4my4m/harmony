// Journey: a server opens on the channel last viewed in it, as Discord's server switch does.
// Switching away and back returns there, from the cached structure and, after a reload, from
// the persisted state. Selecting the server already open keeps the open channel or thread.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let first: SeededServer
let second: SeededServer
let gaming = ''
let threadId = ''

test.beforeAll(async () => {
  me = await createUser(admin, 'slc')
  first = await seedServer(admin, me, `Last A ${me.username}`)
  second = await seedServer(admin, me, `Last B ${me.username}`)
  gaming = await addChannel(admin, first, 'gaming')
  const client = await userClient(me)
  const { data, error } = await client.rpc('create_channel_thread', {
    p_channel_id: gaming,
    p_name: 'Map Tap',
    p_auto_archive_duration: 1440,
  })
  if (error || !data) throw new Error(`thread: ${error?.message}`)
  threadId = data as string
})

test.afterAll(async () => {
  await deleteUser(admin, me)
})

const railEntry = (page: Page, serverId: string) =>
  page.getByRole('navigation', { name: 'Servers' }).locator(`[data-rail-kind="server"][data-rail-id="${serverId}"]`)

const channelUrl = (server: SeededServer, channelId: string) => new RegExp(`/chat/${server.id}/${channelId}$`)

test('a server reopens on the channel last viewed in it', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, me)
  await openChannel(page, first.id, gaming)

  await test.step('away and back returns to #gaming, not the default channel', async () => {
    await railEntry(page, second.id).click()
    await page.waitForURL(channelUrl(second, second.generalChannelId), { timeout: 20000 })
    await railEntry(page, first.id).click()
    await page.waitForURL(channelUrl(first, gaming), { timeout: 20000 })
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })
  })

  await test.step('selecting the open server keeps the open channel', async () => {
    await railEntry(page, first.id).click()
    await page.waitForTimeout(1000)
    await expect(page).toHaveURL(channelUrl(first, gaming))
  })

  await test.step('the remembered channel survives a reload', async () => {
    await railEntry(page, second.id).click()
    await page.waitForURL(channelUrl(second, second.generalChannelId), { timeout: 20000 })
    await page.reload()
    await dismissAnnouncements(page)
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })
    await railEntry(page, first.id).click()
    await page.waitForURL(channelUrl(first, gaming), { timeout: 20000 })
  })

  await test.step('selecting the open server keeps an open thread', async () => {
    await page.goto(`/chat/${first.id}/thread/${threadId}`)
    await dismissAnnouncements(page)
    await expect(page.locator('.channel-thread-item.selected')).toBeVisible({ timeout: 30000 })
    await railEntry(page, first.id).click()
    await page.waitForTimeout(1000)
    await expect(page).toHaveURL(new RegExp(`/chat/${first.id}/thread/${threadId}$`))
  })
})
