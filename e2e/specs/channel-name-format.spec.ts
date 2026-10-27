// Journey: typing a channel name key by key in Create Channel turns each space
// into '-' as it is typed, keeps a trailing '-' while typing, and drops it when
// the channel is created. Renaming a text channel follows the same rule. A category
// keeps its spaces and letter case when created and when renamed.
//
// Keystrokes, not fill(): the name is formatted on every input event, and one
// fill() event cannot show a typed space surviving its own keystroke.
//
// The 100-character cap counts characters as the database's char_length does (code points):
// a name of emoji, two UTF-16 units each, keeps all 100.

import { test, expect } from '@playwright/test'
import {
  addChannel,
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

test('a text channel rename follows the same rule', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await addChannel(admin, server, 'old-name')
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await channelRow(page, 'old-name').click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  const input = dialog.locator('#channel-name')
  await input.fill('')
  await input.pressSequentially('Staff General ', { delay: 30 })
  await expect(input).toHaveValue('staff-general-')
  await dialog.getByRole('button', { name: 'Save changes' }).click()

  await expect.poll(async () => (await admin.from('channels').select('name').eq('id', id).single()).data?.name)
    .toBe('staff-general')
})

test('a category keeps its spaces and case, created and renamed', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await page.locator('.channel-sidebar .server-name').click()
  await page.locator('.server-dropdown li').filter({ hasText: 'Create category' }).click()
  const create = page.getByRole('dialog', { name: 'Create category' })
  const name = create.locator('input.modern-input')
  await name.pressSequentially('Staff  Area', { delay: 30 })
  await expect(name).toHaveValue('Staff Area')
  await create.locator('button').filter({ hasText: 'Create category' }).click()
  await expect(create).toBeHidden({ timeout: 30000 })
  const stored = async (value: string) =>
    (await admin.from('channel_categories').select('id').eq('server_id', server.id).eq('name', value)).data ?? []
  await expect.poll(async () => (await stored('Staff Area')).length).toBe(1)

  await page.locator('.channel-sidebar .category-name').filter({ hasText: /staff area/i }).click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit category' }).click()
  const rename = page.locator('#category-name')
  await rename.fill('  Ops   Team ')
  await page.locator('.modal-footer button').last().click()
  await expect.poll(async () => (await stored('Ops Team')).length).toBe(1)
})

const PARTY = '\u{1F389}'

test('the 100-character cap counts an emoji as one character', async ({ page }) => {
  test.setTimeout(120_000)
  const renamed = await addChannel(admin, server, 'emoji-rename')
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('Create Channel keeps 100 emoji, counts them as 100 and stops at 100', async () => {
    const modal = await openCreateChannel(page)
    const input = modal.locator('input.modern-input')
    await input.fill(PARTY.repeat(101))
    await expect(input).toHaveValue(PARTY.repeat(100))
    await expect(modal.locator('.char-count')).toHaveText(/100\s*\/\s*100/)
    await modal.locator('button').filter({ hasText: 'Create Channel' }).click()
    await expect(modal).toBeHidden({ timeout: 30000 })
    await expect.poll(async () => (await admin.from('channels').select('name').eq('server_id', server.id).eq('name', PARTY.repeat(100))).data?.length ?? 0)
      .toBe(1)
  })

  await test.step('a rename keeps 60 emoji', async () => {
    await channelRow(page, 'emoji-rename').click({ button: 'right' })
    await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit channel' })
    const input = dialog.locator('#channel-name')
    await input.fill(PARTY.repeat(60))
    await expect(input).toHaveValue(PARTY.repeat(60))
    await expect(dialog.locator('#channel-name ~ .character-count')).toHaveText('60/100')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect.poll(async () => (await admin.from('channels').select('name').eq('id', renamed).single()).data?.name)
      .toBe(PARTY.repeat(60))
  })
})
