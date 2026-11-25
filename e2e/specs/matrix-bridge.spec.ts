// Journey: Matrix people show in Harmony as Discord people do. Each relayed author carries the
// platform's icon, or its DISCORD / MATRIX label when Appearance asks for labels, and opens the
// profile card with the platform handle. Server settings has one Bridges entry with a Discord and
// a Matrix tab, and the former Discord Bridge link opens the Discord tab. A member's Bridge privacy
// lists only the platforms the server bridges and keeps the choice across a reload. On the Matrix
// tab, under Use your own bridge program, a manager with no bot of their own reads the setup steps
// and the guide link; the owner of a bot installed in the server pairs channels of its channel list,
// sees each wait for a room and the status card count them, and unpairs the bot. On a server whose
// only bot bridges Matrix, '@' suggests a Matrix person to the bot's owner and to a member its
// private row is hidden from.
//
// MATRIX_TAB_SHOTS=<directory> saves the Matrix tab empty, with the setup form, and paired, at 1440x900.

import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  composer,
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

async function seedBot(
  username: string,
  displayName: string,
  fields: Record<string, unknown>,
  target: SeededServer = server,
  allowedChannelIds: string[] = [target.generalChannelId],
): Promise<string> {
  const { data, error } = await admin
    .from('bots')
    .insert({ username: username.slice(0, 32), display_name: displayName, owner_id: owner.id, is_public: false, ...fields })
    .select('id')
    .single()
  if (error || !data) throw new Error(`bot ${displayName}: ${error?.message}`)
  botIds.push(data.id)
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: data.id, server_id: target.id, installed_by: owner.id, is_active: true,
    read_messages: true, send_messages: true, allowed_channel_ids: allowedChannelIds,
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
    await expect(page.getByTestId('profile-bridged-copy-id')).toHaveText(/Copy Matrix ID/)
    await expect(page.getByTestId('profile-bridged-open')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await row(page, DISCORD_TEXT).locator('button.username').click()
    await expect(page.getByTestId('profile-modal-handle')).toHaveText('@gus')
    // The card keeps people in Harmony: an id to copy, no link to the other platform.
    await expect(page.getByTestId('profile-bridged-copy-id')).toHaveText(/Copy Discord ID/)
    await expect(page.getByTestId('profile-bridged-open')).toHaveCount(0)
    await expect(page.getByText('Open on Discord')).toHaveCount(0)
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

const SHOTS = process.env.MATRIX_TAB_SHOTS ?? ''

/** Viewport capture; `end` is scrolled to the bottom of the viewport first. */
async function shoot(page: Page, file: string, end?: Locator): Promise<void> {
  if (!SHOTS) return
  if (end) await end.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await page.screenshot({ path: path.join(SHOTS, `${file}.png`) })
}

/** The Matrix tab with the form of a bridge program of one's own, chosen first where nothing is paired. */
async function openOwnProgram(page: Page, serverId: string) {
  await page.goto(`/server/${serverId}?section=bridges&tab=matrix`)
  await dismissAnnouncements(page)
  const panel = page.getByTestId('bridges-panel-matrix')
  await expect(panel.getByTestId('bridge-mode-chooser')).toBeVisible({ timeout: 30000 })
  await panel.getByRole('article', { name: 'Use your own bridge program' }).getByRole('button').click()
  await expect(panel.getByTestId('matrix-status')).toBeVisible()
  return panel
}

test.describe('Matrix tab setup', () => {
  let helper: SpecUser
  let bareServer: SeededServer
  let setupServer: SeededServer
  let setupBot = ''
  let newsId = ''
  let secretId = ''
  const setupRoom = () => `!setup${owner.username.slice(-6)}:example.org`

  test.beforeAll(async () => {
    helper = await createUser(admin, 'mxhelper')
    bareServer = await seedServer(admin, helper, `Matrix bare ${helper.username.slice(-6)}`)
    setupServer = await seedServer(admin, owner, `Matrix setup ${owner.username.slice(-6)}`)
    newsId = await addChannel(admin, setupServer, 'news')
    secretId = await addChannel(admin, setupServer, 'secret')
    setupBot = await seedBot(`mxs_${owner.username}`, 'Room Relay', { bot_type: 'bot' }, setupServer, [setupServer.generalChannelId, newsId])
  })

  test.afterAll(async () => {
    await admin.from('servers').delete().in('id', [bareServer?.id, setupServer?.id].filter(Boolean))
    await deleteUser(admin, helper)
  })

  const bindings = async () => {
    const { data, error } = await admin.from('bridge_channels').select('channel_id, room_id, sender_mode').eq('bot_id', setupBot)
    if (error) throw new Error(`bindings: ${error.message}`)
    return ((data ?? []) as { channel_id: string; room_id: string | null; sender_mode: string }[])
      .sort((a, b) => a.channel_id.localeCompare(b.channel_id))
  }

  test('a manager with no bot of their own gets the setup steps and the guide', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page, helper)
    const panel = await openOwnProgram(page, bareServer.id)
    await expect(panel.getByTestId('matrix-status-title')).toHaveText('Not set up')
    await expect(panel.getByTestId('matrix-bridge-empty')).toBeVisible()
    await expect(panel.getByTestId('matrix-setup')).toHaveCount(0)
    const steps = panel.getByTestId('matrix-guide-steps').getByRole('listitem')
    await expect(steps).toHaveCount(4)
    await expect(steps.nth(0)).toContainText('Run the Matrix bridge on a computer')
    await expect(steps.nth(1)).toContainText('User settings → My bots')
    await expect(steps.nth(2)).toContainText('Server settings → Advanced settings → Server bots')
    const link = panel.getByRole('link', { name: /Read the Matrix bridge guide/ })
    await expect(link).toHaveAttribute('href', 'https://docs.mony.lol/run/matrix-bridge')
    await expect(link).toHaveAttribute('target', '_blank')
    await shoot(page, 'matrix-empty')
  })

  test('the owner of a bot in the server pairs channels, sees them wait for rooms, and unpairs', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page, owner)
    const panel = await openOwnProgram(page, setupServer.id)
    const form = panel.getByTestId('matrix-setup')
    const card = (channelId: string) => panel.locator(`[data-testid="matrix-pair"][data-channel="${channelId}"]`)

    await test.step('the empty tab offers the bot and the channels of its channel list', async () => {
      await expect(panel.getByTestId('matrix-status-title')).toHaveText('Not set up')
      await expect(form.getByLabel('Bridge bot')).toHaveValue(setupBot)
      await expect(form.getByRole('checkbox', { name: /#general/ })).toBeEnabled()
      await expect(form.getByRole('checkbox', { name: /#news/ })).toBeEnabled()
      await expect(form.getByRole('checkbox', { name: /#secret/ })).toBeDisabled()
      await expect(form.locator(`[data-channel="${secretId}"]`)).toContainText("Not in Room Relay's channel list")
      await expect(form.getByTestId('matrix-setup-allowlist-help')).toContainText('choose Channels next to Room Relay')
      await shoot(page, 'matrix-setup-form', form)
    })

    await test.step('pairing two channels leaves both waiting for a room', async () => {
      await form.getByRole('checkbox', { name: /#general/ }).check()
      await form.getByRole('checkbox', { name: /#news/ }).check()
      await form.getByRole('button', { name: 'Pair channels' }).click()
      await expect(panel.getByTestId('matrix-bridge-notice')).toHaveText('2 channels are paired with Matrix.')
      await expect(panel.getByTestId('matrix-pair')).toHaveCount(2)
      await expect(card(setupServer.generalChannelId)).toContainText('Waiting for the bridge to connect a room')
      await expect(card(newsId)).toContainText('Waiting for the bridge to connect a room')
      await expect(panel.getByTestId('matrix-status-title')).toHaveText('Waiting for Matrix rooms')
      await expect(panel.getByTestId('matrix-status-bot')).toHaveText('Room Relay')
      await expect(panel.getByTestId('matrix-status-paired')).toHaveText('2')
      await expect(panel.getByTestId('matrix-status-rooms')).toHaveText('0')
      await expect(panel.getByTestId('matrix-status-waiting')).toHaveText('2')
      await expect(page.locator(':focus')).toHaveText('Paired channels')
      expect((await bindings()).map(b => [b.channel_id, b.room_id])).toEqual(
        [[setupServer.generalChannelId, null], [newsId, null]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      )
    })

    await test.step('a room the bridge connects shows on its card and in the counts', async () => {
      const { error } = await admin.rpc('matrix_bridge_bind_room', {
        p_bot_id: setupBot, p_channel_id: setupServer.generalChannelId, p_room_id: setupRoom(), p_initial_sender_mode: 'relay',
      })
      if (error) throw new Error(`bind room: ${error.message}`)
      await panel.getByTestId('matrix-bridge-reload').click()
      await expect(card(setupServer.generalChannelId).getByTestId('matrix-pair-room')).toHaveText(setupRoom())
      await expect(card(setupServer.generalChannelId).getByTestId('matrix-pair-badge')).toHaveText('Connected')
      await expect(panel.getByTestId('matrix-status-rooms')).toHaveText('1')
      await expect(panel.getByTestId('matrix-status-waiting')).toHaveText('1')
    })

    await test.step('how members appear is saved per channel', async () => {
      const select = card(newsId).getByLabel('Harmony members appear in Matrix')
      await select.selectOption('ghost')
      await expect.poll(async () => (await bindings()).find(b => b.channel_id === newsId)?.sender_mode).toBe('ghost')
      await expect(select).toHaveValue('ghost')
      await expect(select).toBeEnabled()
      await shoot(page, 'matrix-paired')
      await shoot(page, 'matrix-paired-cards', panel.getByTestId('matrix-unpair-card'))
    })

    await test.step('unpairing asks first and empties the tab', async () => {
      await panel.getByRole('button', { name: 'Unpair Room Relay from Matrix' }).click()
      const dialog = page.getByRole('alertdialog', { name: /Unpair Room Relay/ })
      await expect(dialog).toContainText('Room Relay stops bridging 2 channels with Matrix.')
      await dialog.getByRole('button', { name: 'Unpair' }).click()
      await expect(panel.getByTestId('matrix-bridge-notice')).toHaveText('Room Relay is unpaired from Matrix.')
      await expect(panel.getByTestId('matrix-status-title')).toHaveText('Not set up')
      await expect(panel.getByTestId('matrix-pair')).toHaveCount(0)
      await expect(form).toBeVisible()
      await expect.poll(bindings).toEqual([])
    })
  })
})

test.describe('a server bridged to Matrix only', () => {
  let matrixServer: SeededServer

  test.beforeAll(async () => {
    matrixServer = await seedServer(admin, owner, `Matrix only ${owner.username.slice(-6)}`)
    await addMember(admin, member, matrixServer.id)
    await seedBot(`mxo_${owner.username}`, 'Matrix Bridge', { bot_type: 'bot', bridge_platform: 'matrix' }, matrixServer)
  })

  test.afterAll(async () => {
    await admin.from('servers').delete().eq('id', matrixServer?.id ?? '')
  })

  for (const viewer of ['owner', 'member'] as const) {
    test(`'@' suggests a Matrix person to the ${viewer}`, async ({ page }) => {
      await page.route(`**/bot-gateway/bridged-users/${matrixServer.generalChannelId}`, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          has_bridge: true,
          users: [{ id: '@sam:example.org', username: 'sam', displayName: 'Sam Matrix', avatarUrl: '', source: 'matrix' }],
        }),
      }))
      await signIn(page, viewer === 'owner' ? owner : member)
      await openChannel(page, matrixServer.id, matrixServer.generalChannelId)
      await composer(page).click()
      await composer(page).pressSequentially('@sam', { delay: 30 })
      const person = page.locator('#auto-suggest-listbox .suggest-item').filter({ hasText: 'Sam Matrix' })
      await expect(person).toHaveCount(1, { timeout: 15000 })
    })
  }
})
