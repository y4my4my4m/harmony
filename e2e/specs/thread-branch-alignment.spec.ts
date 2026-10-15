// Journey: the tree line joining an active thread to its channel in the channel list runs
// under the channel's # icon, and the thread's name starts where the channel's name does,
// on a desktop window and on a phone, where channel rows are padded wider.

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
let user: SpecUser
let server: SeededServer
let gaming = ''

test.beforeAll(async () => {
  user = await createUser(admin, 'tba')
  server = await seedServer(admin, user, `Threads ${user.username}`)
  gaming = await addChannel(admin, server, 'gaming')
  const client = await userClient(user)
  const { error } = await client.rpc('create_channel_thread', {
    p_channel_id: gaming,
    p_name: 'Map Tap',
    p_auto_archive_duration: 1440,
  })
  if (error) throw new Error(`thread: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function geometry(page: Page) {
  const thread = page.locator('.channel-thread-item').filter({ hasText: 'Map Tap' })
  await expect(thread).toBeVisible({ timeout: 30000 })
  return page.evaluate(() => {
    const row = [...document.querySelectorAll('.channel-item')].find((e) => e.textContent?.includes('gaming'))!
    const icon = row.querySelector('.channel-content > svg')!.getBoundingClientRect()
    const name = row.querySelector('.channel-name')!.getBoundingClientRect()
    const item = document.querySelector('.channel-thread-item')!
    const branch = item.querySelector('.thread-branch')!.getBoundingClientRect()
    const line = parseFloat(getComputedStyle(item.querySelector('.thread-branch')!, '::before').width)
    const label = item.querySelector('.thread-name')!.getBoundingClientRect()
    return {
      iconCentre: icon.left + icon.width / 2,
      lineCentre: branch.left + line / 2,
      nameLeft: name.left,
      labelLeft: label.left,
    }
  })
}

async function open(page: Page) {
  await signIn(page, user)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
}

test('the thread line sits under the channel icon on desktop', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const g = await geometry(page)
  expect(Math.abs(g.lineCentre - g.iconCentre)).toBeLessThanOrEqual(1.5)
  expect(Math.abs(g.labelLeft - g.nameLeft)).toBeLessThanOrEqual(1)
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('the thread line sits under the channel icon', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    await page.getByRole('button', { name: 'Navigation menu' }).first().click()
    const g = await geometry(page)
    expect(Math.abs(g.lineCentre - g.iconCentre)).toBeLessThanOrEqual(1.5)
    expect(Math.abs(g.labelLeft - g.nameLeft)).toBeLessThanOrEqual(1)
  })
})
