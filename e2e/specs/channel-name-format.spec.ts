// Journey: typing a channel name key by key in Create Channel turns each space
// into '-' as it is typed, keeps a trailing '-' while typing, and drops it when
// the channel is created.
//
// Keystrokes, not fill(): the name is formatted on every input event, and one
// fill() event cannot show a typed space surviving its own keystroke.

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
  owner = await createUser(admin, 'cnf')
  server = await seedServer(admin, owner, `Names ${owner.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

test('spaces become hyphens as they are typed in Create Channel', async ({ page }) => {
  test.setTimeout(120_000)

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const modal = await openCreateChannel(page)
  const input = modal.locator('input.modern-input')

  await test.step('each typed space becomes a hyphen', async () => {
    await input.click()
    await input.pressSequentially('Road Map', { delay: 30 })
    await expect(input).toHaveValue('road-map')
  })

  await test.step('a trailing separator survives the keystroke', async () => {
    await input.pressSequentially(' ', { delay: 30 })
    await expect(input).toHaveValue('road-map-')
    await input.pressSequentially('2026 ', { delay: 30 })
    await expect(input).toHaveValue('road-map-2026-')
  })

  await test.step('creating drops the trailing hyphen', async () => {
    await modal.locator('button').filter({ hasText: 'Create Channel' }).click()
    await expect(modal).toBeHidden({ timeout: 30000 })
    await expect(channelRow(page, 'road-map-2026')).toBeVisible({ timeout: 30000 })
    const { data } = await admin.from('channels').select('name').eq('server_id', server.id)
    expect((data ?? []).map((c) => c.name)).toContain('road-map-2026')
  })
})
