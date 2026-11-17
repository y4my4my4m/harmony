// Journey: Matrix people show in Harmony as Discord people do. Each relayed author carries the
// platform's icon, or its DISCORD / MATRIX label when Appearance asks for labels, and opens the
// profile card with the platform handle. Server settings has one Bridges entry with a Discord and
// a Matrix tab, and the former Discord Bridge link opens the Discord tab. A member's Bridge privacy
// lists only the platforms the server bridges and keeps the choice across a reload.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer
const botIds: string[] = []
let roomId = ''
const MATRIX_TEXT = 'hello from a Matrix room'
const DISCORD_TEXT = 'hello from a Discord server'

async function seedBot(username: string, displayName: string, fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin
    .from('bots')
    .insert({ username: username.slice(0, 32), display_name: displayName, owner_id: owner.id, is_public: false, ...fields })
    .select('id')
    .single()
  if (error || !data) throw new Error(`bot ${displayName}: ${error?.message}`)
  botIds.push(data.id)
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: data.id, server_id: server.id, installed_by: owner.id, is_active: true,
    read_messages: true, send_messages: true, allowed_channel_ids: [server.generalChannelId],
  })
  if (installError) throw new Error(`install ${displayName}: ${installError.message}`)
  return data.id
}

async function relay(botId: string, text: string, metadata: Record<string, unknown>, minutesAgo: number) {
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    bot_id: botId,
    content: [{ type: 'text', text }],
    metadata: { bot: true, created_via: 'bot_api', ...metadata },
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  })
  if (error) throw new Error(`relay "${text}": ${error.message}`)
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'mxowner')
  member = await createUser(admin, 'mxmember')
  server = await seedServer(admin, owner, `Matrix ${owner.username.slice(-6)}`)
  await addMember(admin, member, server.id)

  roomId = `!${owner.username}:example.org`
  const matrixBot = await seedBot(`mx_${owner.username}`, 'Matrix Bridge', { bot_type: 'bot', bridge_platform: 'matrix' })
  const { error: bindError } = await admin.from('bridge_channels').insert({
    bot_id: matrixBot, channel_id: server.generalChannelId, platform: 'matrix', room_id: roomId, sender_mode: 'ghost',
  })
  if (bindError) throw new Error(`bind: ${bindError.message}`)
  const discordBot = await seedBot(`dc_${owner.username}`, 'Discord Bridge', { bot_type: 'bridge' })

  await relay(matrixBot, MATRIX_TEXT, {
    bridge_source: 'matrix',
    matrix_user: { id: '@sam:example.org', username: 'sam', display_name: 'Sam Matrix' },
  }, 2)
  await relay(discordBot, DISCORD_TEXT, {
    bridge_source: 'discord',
    discord_message_id: '1500000000000000011',
    discord_user: { id: '1500000000000000012', username: 'gus', display_name: 'Gus Discord' },
  }, 1)
})

test.afterAll(async () => {
  for (const id of botIds) await admin.from('bots').delete().eq('id', id)
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

const row = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })

async function useLabels(page: Page) {
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  const select = page.getByRole('combobox', { name: 'Bridge source indicator' })
  await expect(select).toBeVisible({ timeout: 30000 })
  await select.selectOption('text')
  const bar = page.locator('[data-testid="appearance-save-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar).toBeHidden({ timeout: 15000 })
}

test('a Matrix person shows as a Discord person does, by icon or by label', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('each relayed author has its name and its platform icon', async () => {
    const matrixRow = row(page, MATRIX_TEXT)
    const discordRow = row(page, DISCORD_TEXT)
    await expect(matrixRow.locator('button.username')).toHaveText('Sam Matrix', { timeout: 30000 })
    await expect(discordRow.locator('button.username')).toHaveText('Gus Discord')
    await expect(matrixRow.locator('.bridged-source-icon.matrix')).toHaveAttribute('aria-label', 'Bridged from Matrix')
    await expect(discordRow.locator('.bridged-source-icon.discord')).toHaveAttribute('aria-label', 'Bridged from Discord')
    await expect(matrixRow).not.toContainText('(matrix)')
    await expect(matrixRow).not.toContainText('@sam:example.org')
  })

  await test.step('the Matrix author opens the profile card with the Matrix handle, as the Discord one does', async () => {
    await row(page, MATRIX_TEXT).locator('button.username').click()
    await expect(page.getByTestId('profile-modal-handle')).toHaveText('@sam:example.org')
    await expect(page.getByText('Open on Matrix')).toBeVisible()
    await page.keyboard.press('Escape')
    await row(page, DISCORD_TEXT).locator('button.username').click()
    await expect(page.getByTestId('profile-modal-handle')).toHaveText('@gus')
    await page.keyboard.press('Escape')
  })

  await test.step('with labels, both carry their platform label', async () => {
    await useLabels(page)
    await openChannel(page, server.id, server.generalChannelId)
    await expect(row(page, MATRIX_TEXT).locator('.bridge-source-badge.matrix')).toHaveText('MATRIX', { timeout: 30000 })
    await expect(row(page, DISCORD_TEXT).locator('.bridge-source-badge.discord')).toHaveText('DISCORD')
    await expect(row(page, MATRIX_TEXT).locator('.bridged-source-icon')).toHaveCount(0)
  })
})

test('Server settings has one Bridges entry with a Discord and a Matrix tab', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)

  await test.step('the former Matrix link opens the Matrix tab with the server\'s pair', async () => {
    await page.goto(`/server/${server.id}?section=matrix-bridge`)
    await dismissAnnouncements(page)
    await expect(page.getByTestId('bridges-settings')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('bridges-tab-matrix')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('bridges-panel-matrix').getByTestId('matrix-pair')).toHaveCount(1)
    await expect(page.getByTestId('bridges-panel-matrix')).toContainText(roomId)
  })

  await test.step('the navigation lists Bridges once and no per-platform entry', async () => {
    const integrations = page.getByRole('list', { name: 'Integrations' })
    await expect(integrations.getByRole('button', { name: 'Bridges' })).toHaveCount(1)
    await expect(integrations.getByRole('button', { name: /Discord Bridge|Matrix Bridge/ })).toHaveCount(0)
  })

  await test.step('the Discord tab holds the Discord bridge setup', async () => {
    await page.getByTestId('bridges-tab-discord').click()
    await expect(page.getByTestId('bridges-tab-discord')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('bridges-panel-discord').getByTestId('discord-bridge')).toBeVisible()
  })

  await test.step('the former Discord Bridge link opens the Discord tab', async () => {
    await page.goto(`/server/${server.id}?section=discord-bridge`)
    await expect(page.getByTestId('bridges-tab-discord')).toHaveAttribute('aria-selected', 'true', { timeout: 30000 })
    await expect(page.getByTestId('bridges-panel-discord').getByTestId('discord-bridge')).toBeVisible()
  })
})

test('Bridge privacy lists the bridged platforms only and keeps the choice', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)

  const openPrivacy = async () => {
    const strip = page.locator('[data-region="nav"]')
    await strip.locator('.server-header .server-name').click()
    await strip.locator('.server-dropdown').getByTestId('server-bridge-privacy').click()
    const dialog = page.getByRole('dialog', { name: 'Bridge privacy' })
    await expect(dialog).toBeVisible()
    return dialog
  }

  await test.step('only Matrix is offered: the server bridges no Discord server', async () => {
    const dialog = await openPrivacy()
    await expect(dialog.locator('.privacy-row')).toHaveCount(1)
    await expect(dialog.locator('.privacy-row[data-platform="matrix"]')).toBeVisible()
    await dialog.locator('.privacy-row[data-platform="matrix"]').getByRole('switch').click()
    await expect.poll(async () => {
      const { data } = await admin.from('bridge_member_optouts').select('platform')
        .eq('server_id', server.id).eq('user_id', member.id)
      return (data ?? []).map((r: { platform: string }) => r.platform)
    }).toEqual(['matrix'])
    await page.keyboard.press('Escape')
  })

  await test.step('after a reload the switch is still on', async () => {
    await page.reload()
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })
    const dialog = await openPrivacy()
    await expect(dialog.locator('.privacy-row[data-platform="matrix"]').getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })
})
