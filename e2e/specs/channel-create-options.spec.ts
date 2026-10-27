// Journey: Create Channel offers, under a collapsed "More options", the settings the channel
// editor shows: a description for every channel and slowmode for a text channel. The values are
// stored by the one create_channel call that creates the channel.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  openChannel,
  openCreateChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'cco')
  server = await seedServer(admin, owner, `Options ${owner.username}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, owner)
})

test('a text channel is created with its description and slowmode', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const createCalls: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/rest/v1/rpc/create_channel')) {
      createCalls.push(request.postDataJSON() as Record<string, unknown>)
    }
  })

  const modal = await openCreateChannel(page)
  await modal.locator('input.modern-input').fill('announcements')

  const more = modal.getByRole('button', { name: 'More options' })
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(modal.getByLabel('Description')).toBeHidden()
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')

  await modal.getByLabel('Description').fill('Release notes and news')
  const slowmode = modal.getByLabel('Slowmode')
  await slowmode.focus()
  // Steps 0, 5, 10, 15, 30 seconds.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(slowmode).toHaveAttribute('aria-valuetext', '30 seconds')

  await modal.locator('button').filter({ hasText: 'Create Channel' }).click()
  await expect(modal).toBeHidden({ timeout: 30000 })
  await expect(channelRow(page, 'announcements')).toBeVisible({ timeout: 30000 })

  const { data } = await admin.from('channels').select('description, slowmode_seconds')
    .eq('server_id', server.id).eq('name', 'announcements').single()
  expect(data).toEqual({ description: 'Release notes and news', slowmode_seconds: 30 })
  expect(createCalls).toHaveLength(1)
  expect(createCalls[0]).toMatchObject({ p_description: 'Release notes and news', p_slowmode_seconds: 30 })
})

test('a voice channel offers a description and no slowmode', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const modal = await openCreateChannel(page)
  await modal.locator('label.channel-type-option:has([data-testid="channel-type-voice"])').click()
  await modal.locator('input.modern-input').fill('Stage Door')
  await modal.getByRole('button', { name: 'More options' }).click()
  await expect(modal.getByLabel('Slowmode')).toHaveCount(0)
  await modal.getByLabel('Description').fill('Weekly town hall')
  await modal.locator('button').filter({ hasText: 'Create Channel' }).click()
  await expect(modal).toBeHidden({ timeout: 30000 })

  await expect.poll(async () => (await admin.from('channels').select('description')
    .eq('server_id', server.id).eq('name', 'Stage Door').maybeSingle()).data?.description).toBe('Weekly town hall')
})
