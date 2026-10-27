// Journey: one naming rule per channel type, applied by every writer. A voice channel keeps its
// spaces and letter case when created and when renamed: a run of spaces becomes one, the ends are
// trimmed, and punctuation and emoji stay. A text channel is lowercase with '-' for spaces. The
// database applies the same rule to create_channel and to service-role writes (bots, templates).
//
// Keystrokes, not fill(): the name is formatted on every input event.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  openChannel,
  openCreateChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'cnr')
  server = await seedServer(admin, owner, `Naming ${owner.username}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, owner)
})

const storedName = async (id: string) =>
  (await admin.from('channels').select('name').eq('id', id).single()).data?.name

function voiceOption(modal: Locator): Locator {
  return modal.locator('label.channel-type-option:has([data-testid="channel-type-voice"])')
}

async function editChannel(page: Page, name: string): Promise<Locator> {
  await channelRow(page, name).click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  return dialog
}

test('a voice channel keeps spaces, case, punctuation and emoji when created', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const modal = await openCreateChannel(page)
  await voiceOption(modal).click()
  const input = modal.locator('input.modern-input')
  await input.click()
  await input.pressSequentially("  Mike's  Room 🎮", { delay: 30 })
  await expect(input).toHaveValue("Mike's Room 🎮")

  await modal.locator('button').filter({ hasText: 'Create Channel' }).click()
  await expect(modal).toBeHidden({ timeout: 30000 })
  await expect.poll(async () => (await admin.from('channels').select('name')
    .eq('server_id', server.id).eq('type', 1).eq('name', "Mike's Room 🎮")).data?.length ?? 0).toBe(1)
  await expect(channelRow(page, "Mike's Room 🎮")).toBeVisible({ timeout: 30000 })
})

test('a voice channel rename keeps spaces and case', async ({ page }) => {
  test.setTimeout(120_000)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data: lounge, error } = await admin.from('channels')
    .insert({ server_id: server.id, name: 'Lounge', type: 1, category: general?.category ?? null })
    .select('id').single()
  if (error || !lounge) throw new Error(`voice channel: ${error?.message}`)

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const dialog = await editChannel(page, 'Lounge')
  const input = dialog.locator('#channel-name')
  await input.fill('')
  await input.pressSequentially('  Late  Night Talk ', { delay: 30 })
  await expect(input).toHaveValue('Late Night Talk ')
  await dialog.getByRole('button', { name: 'Save changes' }).click()

  await expect.poll(() => storedName(lounge.id)).toBe('Late Night Talk')
})

test('the database applies the rule to create_channel and to service-role writes', async () => {
  const client = await userClient(owner)

  const text = await client.rpc('create_channel', { p_server_id: server.id, p_name: 'Release Notes!', p_type: 0 })
  expect(text.error).toBeNull()
  expect(text.data?.name).toBe('release-notes')
  expect(await storedName(text.data.id)).toBe('release-notes')

  const voice = await client.rpc('create_channel', { p_server_id: server.id, p_name: '  Town   Hall ', p_type: 1 })
  expect(voice.error).toBeNull()
  expect(await storedName(voice.data.id)).toBe('Town Hall')

  // Bots and server templates write as service_role.
  const { data: bot, error: botError } = await admin.from('channels')
    .insert({ server_id: server.id, name: 'Bot Made Channel', type: 0 })
    .select('id, name').single()
  expect(botError).toBeNull()
  expect(bot?.name).toBe('bot-made-channel')

  // A channel mirrored from another instance keeps the name its origin gave it.
  const { data: remote, error: remoteError } = await admin.from('channels')
    .insert({ server_id: server.id, name: 'Mirrored Name', type: 0, is_remote: true })
    .select('id, name').single()
  expect(remoteError).toBeNull()
  expect(remote?.name).toBe('Mirrored Name')

  const renamed = await client.from('channels').update({ name: 'Weekly Sync' }).eq('id', text.data.id).select('name').single()
  expect(renamed.error).toBeNull()
  expect(renamed.data?.name).toBe('weekly-sync')

  const refused = await client.rpc('create_channel', { p_server_id: server.id, p_name: '!!!', p_type: 0 })
  expect(refused.error?.code).toBe('23514')
})
