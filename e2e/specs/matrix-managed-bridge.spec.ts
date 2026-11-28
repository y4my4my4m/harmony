// Journey: a manager sets up a Matrix bridge from Server settings → Bridges → Matrix. The chooser
// offers running it yourself and a bridge program of one's own. Running it yourself shows a setup
// code, renewed on request, and the commands that carry it and what was entered, for an application
// service and for a Matrix account. This spec plays the
// bridge through the service role: it redeems the code as the gateway does and reports its status.
// The tab follows the bridge from the missing registration to the pairs; a channel is paired with a
// room of the bridge's list and another with a typed alias, encrypted channels and rooms are greyed
// with the reason, an error of one pair shows on its card, a pair's options change, a pair is
// removed, a bridge silent for more than 90 s reads as offline, and the bridge is disconnected. A
// server whose own bridge program was set up in 1.9.8 opens on it unchanged, keeps it beside a
// managed bridge, and returns to it.
//
// MATRIX_TAB_SHOTS=<directory> saves the chooser, the command, the pairs and the status at 1440x900
// and at 390x844.

import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { addChannel, adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let newsId = ''
let secretId = ''
const botIds: string[] = []
const ACCOUNT = '@harmony_relay:example.org'

const room = (name: string) => `!${name}${owner.username.slice(-6)}:example.org`
const ROOMS = () => [
  { room_id: room('general'), name: 'Town Square', alias: '#town:example.org', encrypted: false, can_send: true, members: 4, invited: false },
  { room_id: room('vault'), name: 'Vault', alias: null, encrypted: true, can_send: true, members: 2, invited: false },
  { room_id: room('lobby'), name: 'Lobby', alias: null, encrypted: false, can_send: true, members: 0, invited: true },
]

interface Report {
  ready?: boolean
  problems?: { code: string; detail?: string }[]
  pairs?: { channel_id: string; state: string; error?: string | null }[]
}

async function bridgeOf(serverId: string) {
  const { data, error } = await admin.from('matrix_bridges').select('id, bot_id, mode, last_seen_at').eq('server_id', serverId).maybeSingle()
  if (error) throw new Error(`bridge: ${error.message}`)
  return data as { id: string; bot_id: string; mode: string; last_seen_at: string | null } | null
}

/** POST /bridge/v2/matrix/status as the gateway stores it. */
async function report(serverId: string, { ready = true, problems = [], pairs = [] }: Report = {}) {
  const bridge = await bridgeOf(serverId)
  const { data, error } = await admin.rpc('matrix_bridge_report_status', {
    p_bot_id: bridge!.bot_id,
    p_connection: 'application_service',
    p_status: { ready, user_id: ACCOUNT, homeserver: 'https://matrix.example.org', server_name: 'example.org', pending: 0, failed: 0, problems },
    p_snapshot: { rooms: ready ? ROOMS() : [] },
    p_version: '0.2.0',
    p_pairs: pairs,
  })
  if (error) throw new Error(`report: ${error.message}`)
  expect(data).toEqual({ ok: true })
}

async function pairsOf(serverId: string) {
  const bridge = await bridgeOf(serverId)
  const { data, error } = await admin.from('bridge_channels').select('channel_id, room_id, room_alias, direction, sender_mode').eq('bot_id', bridge!.bot_id)
  if (error) throw new Error(`pairs: ${error.message}`)
  return Object.fromEntries((data as { channel_id: string }[]).map(({ channel_id, ...rest }) => [channel_id, rest]))
}

const SHOTS = process.env.MATRIX_TAB_SHOTS ?? ''
async function shoot(page: Page, file: string, target?: Locator): Promise<void> {
  if (!SHOTS) return
  for (const [suffix, size] of [['', { width: 1440, height: 900 }], ['-phone', { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size)
    // The section list slides out of the narrowed window.
    if (suffix) await page.waitForTimeout(500)
    if (target) await target.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: path.join(SHOTS, `${file}${suffix}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

async function openMatrixTab(page: Page, serverId: string) {
  await page.goto(`/server/${serverId}?section=bridges&tab=matrix`)
  await dismissAnnouncements(page)
  const panel = page.getByTestId('bridges-panel-matrix')
  await expect(panel.getByTestId('matrix-bridge')).toBeVisible({ timeout: 30000 })
  return panel
}

const card = (panel: Locator, channelId: string) => panel.locator(`[data-testid="matrix-managed-pair"][data-channel="${channelId}"]`)

const OFFERS = ['matrix_bridge_hosting_enabled', 'matrix_bridge_instance_enabled']
const offered = new Map<string, unknown>()

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeAll(async () => {
  owner = await createUser(admin, 'mxmanaged')
  server = await seedServer(admin, owner, `Managed ${owner.username.slice(-6)}`)
  newsId = await addChannel(admin, server, 'news')
  secretId = await addChannel(admin, server, 'secret')
  for (const [table, row] of [
    ['server_encryption_settings', { server_id: server.id, encryption_mode: 'optional' }],
    ['channel_encryption_settings', { channel_id: secretId, messages_encrypted: true }],
  ] as const) {
    const { error } = await admin.from(table).upsert(row)
    if (error) throw new Error(`${table}: ${error.message}`)
  }
  // The instance offers no bridge of its own here.
  for (const key of OFFERS) {
    const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).maybeSingle()
    offered.set(key, data?.config_value ?? false)
    await admin.from('instance_config').update({ config_value: false }).eq('config_key', key)
  }
})

test.afterAll(async () => {
  for (const [key, value] of offered) await admin.from('instance_config').update({ config_value: value }).eq('config_key', key)
  for (const id of botIds) await admin.from('bots').delete().eq('id', id)
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
})

test('a manager sets up, uses and disconnects a Matrix bridge they run themselves', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, owner)
  const panel = await openMatrixTab(page, server.id)
  let code = ''

  await test.step('the chooser offers running it yourself and a program of your own', async () => {
    const chooser = panel.getByTestId('bridge-mode-chooser')
    await expect(chooser.getByRole('article')).toHaveCount(2)
    await expect(chooser.getByRole('article', { name: 'Run it yourself' })).toBeVisible()
    await expect(chooser.getByRole('article', { name: 'Use your own bridge program' })).toBeVisible()
    await shoot(page, 'matrix-chooser', chooser)
    await chooser.getByRole('button', { name: 'Run it myself' }).click()
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'connect')
    expect((await bridgeOf(server.id))?.mode).toBe('self')
  })

  await test.step('the setup code is shown, and New code replaces it in the command', async () => {
    const line = panel.getByTestId('setup-code')
    await expect(line).toContainText(/MX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)
    const first = (await line.locator('code').innerText()).trim()
    await expect(panel.getByTestId('docker-run')).toContainText(`HARMONY_SETUP_CODE=${first}`)
    await panel.getByTestId('new-code').click()
    await expect(line.locator('code')).not.toHaveText(first)
    code = (await line.locator('code').innerText()).trim()
    await expect(panel.getByTestId('docker-run')).toContainText(`HARMONY_SETUP_CODE=${code}`)
    const { data } = await admin.rpc('matrix_bridge_redeem_code', { p_code: first })
    expect(data, 'the replaced code redeems nothing').toBeNull()
  })

  await test.step('the commands take in what is entered, for Docker, Compose and the source', async () => {
    await panel.getByLabel('Homeserver address').fill('matrix.example.org')
    await expect(panel.getByTestId('matrix-field-homeserverUrl-help')).toContainText('Enter an address such as')
    await panel.getByLabel('Homeserver address').fill('https://matrix.example.org')
    await panel.getByLabel('Server name').fill('example.org')
    await panel.getByLabel('Address of the bridge').fill('http://10.0.0.5:9009')
    await expect(panel.getByTestId('docker-run')).toContainText(
      '-e MATRIX_HOMESERVER_URL=https://matrix.example.org -e MATRIX_SERVER_NAME=example.org -e MATRIX_APPSERVICE_URL=http://10.0.0.5:9009',
    )
    await shoot(page, 'matrix-command', panel.locator('.step-panel'))
    await panel.getByRole('tab', { name: 'Docker command' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByTestId('docker-compose')).toContainText('MATRIX_SERVER_NAME: "example.org"')
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('tab', { name: 'From source' })).toBeFocused()
    await expect(panel.getByTestId('matrix-source-env')).toContainText(`HARMONY_SETUP_CODE=${code}`)
  })

  await test.step('a Matrix account needs less, and a command signs it in from the terminal', async () => {
    await panel.getByRole('tab', { name: 'Docker command' }).click()
    await panel.getByLabel(/^With a Matrix account/).check()
    await expect(panel.getByLabel('Server name')).toHaveCount(0)
    await expect(panel.getByTestId('matrix-registration')).toHaveCount(0)
    await expect(panel.getByTestId('matrix-login')).toContainText('-e MATRIX_HOMESERVER_URL=https://matrix.example.org ')
    await expect(panel.getByTestId('matrix-login')).toContainText('node dist/index.js --login')
    await expect(panel.getByTestId('matrix-token-note')).toContainText('on matrix.org they do, within minutes')
    await expect(panel.getByTestId('docker-run')).toContainText('-e MATRIX_ACCESS_TOKEN=PASTE_YOUR_MATRIX_ACCESS_TOKEN_HERE')
    await expect(panel.getByTestId('docker-run')).not.toContainText('-p 9009')
    await panel.getByLabel(/^On a homeserver you run/).check()
    await expect(panel.getByLabel('Server name')).toHaveValue('example.org')
  })

  await test.step('the tab waits for the bridge and says what keeps it from connecting', async () => {
    await panel.getByRole('button', { name: 'I ran the command' }).click()
    await expect(panel.getByTestId('check-waiting')).toContainText('Waiting for your bridge to connect')
    const { data, error } = await admin.rpc('matrix_bridge_redeem_code', { p_code: code })
    expect(error).toBeNull()
    const redeemed = data as { bridge_id: string; server_id: string; harmony_token: string }
    expect(redeemed.server_id).toBe(server.id)
    expect(redeemed.harmony_token).toMatch(/^harmony_bot_[0-9a-f]{64}$/)
    await report(server.id, { ready: false, problems: [{ code: 'matrix_registration_missing' }] })
    await expect(panel.locator('[data-check="bridge"]')).toHaveAttribute('data-state', 'ok', { timeout: 15000 })
    await expect(panel.locator('[data-check="matrix"]')).toHaveAttribute('data-state', 'fail')
    await expect(panel.locator('[data-code="matrix_registration_missing"]')).toContainText('docker cp harmony-matrix-bridge:/data/registration.json .')
  })

  await test.step('once it is connected the pairing step opens, with encrypted channels and rooms greyed', async () => {
    await report(server.id)
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'channels', { timeout: 15000 })
    await expect(panel.getByTestId('matrix-invite-hint')).toContainText(ACCOUNT)
    const channel = panel.getByLabel('Harmony channel')
    await expect(channel.getByRole('option', { name: '#secret (end-to-end encrypted)' })).toBeDisabled()
    await expect(channel.getByRole('option', { name: '#news' })).toBeEnabled()
    const rooms = panel.getByLabel('Matrix room')
    await expect(rooms.getByRole('option', { name: 'Vault (end-to-end encrypted)' })).toBeDisabled()
    await expect(rooms.getByRole('option', { name: 'Town Square (#town:example.org)' })).toBeEnabled()
    await expect(rooms.locator('optgroup[label^="Invitations"] option')).toHaveText(['Lobby'])
    await shoot(page, 'matrix-pairing', panel.locator('.step-panel'))
  })

  await test.step('a channel is paired with a room of the list', async () => {
    await panel.getByLabel('Harmony channel').selectOption(server.generalChannelId)
    await panel.getByLabel('Matrix room').selectOption(room('general'))
    await panel.getByRole('button', { name: 'Add pair' }).click()
    const general = card(panel, server.generalChannelId)
    await expect(general.getByTestId('matrix-pair-room')).toHaveText('Town Square')
    await expect(general.getByTestId('matrix-pair-badge')).toHaveText('Waiting for the bridge')
    expect((await pairsOf(server.id))[server.generalChannelId]).toEqual({
      room_id: room('general'), room_alias: null, direction: 'both', sender_mode: 'ghost',
    })
  })

  await test.step('another is paired with a typed alias, refused first when it is none', async () => {
    await panel.getByLabel('Harmony channel').selectOption(newsId)
    await panel.getByLabel('Matrix room').selectOption('Another room…')
    await panel.getByLabel('Room address or ID').fill('not a room')
    await panel.getByRole('button', { name: 'Add pair' }).click()
    await expect(panel.getByTestId('room-address-help')).toContainText("That isn't a room address.")
    await panel.getByLabel('Room address or ID').fill('https://matrix.to/#/%23news:example.org')
    await panel.getByTestId('select-direction').selectOption('to_matrix')
    await panel.getByRole('button', { name: 'Add pair' }).click()
    await expect(card(panel, newsId).getByTestId('matrix-pair-room')).toHaveText('#news:example.org')
    expect((await pairsOf(server.id))[newsId]).toEqual({
      room_id: null, room_alias: '#news:example.org', direction: 'to_matrix', sender_mode: 'ghost',
    })
    const { data } = await admin.from('bot_server_permissions').select('allowed_channel_ids, manage_channels').eq('bot_id', (await bridgeOf(server.id))!.bot_id).single()
    expect([...(data!.allowed_channel_ids as string[])].sort()).toEqual([newsId, server.generalChannelId].sort())
    expect(data!.manage_channels).toBe(false)
  })

  await test.step('what the bridge reports of each pair shows on its card', async () => {
    // PUT bridge-room: a pair works once the bridge bound its room.
    const bound = await admin.rpc('matrix_bridge_bind_room', {
      p_bot_id: (await bridgeOf(server.id))!.bot_id, p_channel_id: server.generalChannelId, p_room_id: room('general'), p_initial_sender_mode: 'relay',
    })
    expect(bound.error).toBeNull()
    await report(server.id, {
      pairs: [
        { channel_id: server.generalChannelId, state: 'ready' },
        { channel_id: newsId, state: 'error', error: 'not_invited' },
      ],
    })
    await expect(card(panel, server.generalChannelId).getByTestId('matrix-pair-badge')).toHaveText('Working', { timeout: 15000 })
    await expect(card(panel, newsId).getByTestId('matrix-pair-badge')).toHaveText('Not working')
    await expect(card(panel, newsId).getByTestId('matrix-pair-error')).toContainText(`Invite ${ACCOUNT} to it on Matrix.`)
    await panel.getByRole('button', { name: 'Finish setup' }).click()
    await expect(panel.getByTestId('status-title')).toHaveText('Bridge is online, with problems')
    await shoot(page, 'matrix-status', panel.getByTestId('matrix-managed-status'))
  })

  await test.step('after a reload the status view names the account and the version', async () => {
    await page.reload()
    await expect(panel.getByTestId('status-account')).toHaveText(ACCOUNT, { timeout: 30000 })
    await expect(panel.getByTestId('status-homeserver')).toHaveText('example.org')
    await expect(panel.getByTestId('status-version')).toHaveText('0.2.0')
    await expect(panel.getByTestId('bridge-privacy')).toHaveAttribute('data-platform', 'matrix')
  })

  await test.step('a pair\'s direction and how members appear are saved per pair', async () => {
    const general = card(panel, server.generalChannelId)
    await general.getByLabel('Direction').selectOption('to_harmony')
    await expect.poll(async () => (await pairsOf(server.id))[server.generalChannelId]).toMatchObject({ direction: 'to_harmony', sender_mode: 'ghost', room_id: room('general') })
    await general.getByLabel('Harmony members appear in Matrix').selectOption('relay')
    await expect.poll(async () => (await pairsOf(server.id))[server.generalChannelId]).toMatchObject({ direction: 'to_harmony', sender_mode: 'relay', room_id: room('general') })
    await expect(general.getByTestId('matrix-pair-badge')).toHaveText('Working')
  })

  await test.step('removing a pair frees its channel and room', async () => {
    await panel.getByRole('button', { name: 'Remove the pair #news and #news:example.org' }).click()
    await expect(card(panel, newsId)).toHaveCount(0)
    expect(Object.keys(await pairsOf(server.id))).toEqual([server.generalChannelId])
    await expect(panel.getByLabel('Harmony channel').getByRole('option', { name: '#news' })).toBeEnabled()
    await expect(panel.getByTestId('status-title')).toHaveText('Bridge is online')
  })

  await test.step('a bridge that has not reported for more than 90 s reads as offline', async () => {
    const { error } = await admin.from('matrix_bridges').update({ last_seen_at: new Date(Date.now() - 95_000).toISOString() }).eq('server_id', server.id)
    expect(error).toBeNull()
    await expect(panel.getByTestId('status-title')).toHaveText('Bridge is offline', { timeout: 15000 })
    await expect(panel.locator('[data-code="bridge_offline"]')).toContainText('docker start harmony-matrix-bridge')
    await report(server.id)
    await expect(panel.getByTestId('status-title')).toHaveText('Bridge is online', { timeout: 15000 })
  })

  await test.step('the bridge of the server is not offered to a program of one\'s own', async () => {
    await panel.getByText('Use your own bridge program as well').click()
    await expect(panel.getByTestId('matrix-custom')).toBeVisible()
    await expect(panel.getByTestId('matrix-custom').getByTestId('matrix-pair')).toHaveCount(0)
    await expect(panel.getByTestId('matrix-setup')).toHaveCount(0)
  })

  await test.step('disconnecting asks first and returns to the chooser', async () => {
    const bot = (await bridgeOf(server.id))!.bot_id
    await panel.getByRole('button', { name: 'Disconnect bridge' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Disconnect the bridge?' })
    await expect(dialog).toContainText('docker rm -f harmony-matrix-bridge')
    await dialog.getByRole('button', { name: 'Disconnect' }).click()
    await expect(panel.getByTestId('bridge-mode-chooser')).toBeVisible()
    expect(await bridgeOf(server.id)).toBeNull()
    const { count } = await admin.from('bridge_channels').select('*', { count: 'exact', head: true }).eq('bot_id', bot)
    expect(count).toBe(0)
  })
})

test('a bridge program set up in 1.9.8 shows and works as before, also beside a managed bridge', async ({ page }) => {
  test.setTimeout(150_000)
  const kept = await seedServer(admin, owner, `Kept ${owner.username.slice(-6)}`)
  const otherId = await addChannel(admin, kept, 'other')
  const { data: bot, error } = await admin
    .from('bots')
    .insert({ username: `mxk_${owner.username}`.slice(0, 32), display_name: 'Own Relay', owner_id: owner.id, is_public: false, bot_type: 'bot', bridge_platform: 'matrix' })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  botIds.push(bot.id)
  // Rows as configure_matrix_bridge and matrix_bridge_bind_room of 1.9.8 left them.
  for (const [table, row] of [
    ['bot_server_permissions', { bot_id: bot.id, server_id: kept.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true, allowed_channel_ids: [kept.generalChannelId, otherId] }],
    ['bridge_channels', { bot_id: bot.id, channel_id: kept.generalChannelId, platform: 'matrix', room_id: room('kept'), sender_mode: 'ghost' }],
  ] as const) {
    const { error: seedError } = await admin.from(table).insert(row)
    if (seedError) throw new Error(`${table}: ${seedError.message}`)
  }

  await signIn(page, owner)
  const panel = await openMatrixTab(page, kept.id)
  const own = (channelId: string) => panel.locator(`[data-testid="matrix-pair"][data-channel="${channelId}"]`)

  await test.step('the tab opens on it, without the chooser', async () => {
    await expect(panel.getByTestId('matrix-status-title')).toHaveText('Bridged to Matrix')
    await expect(own(kept.generalChannelId).getByTestId('matrix-pair-room')).toHaveText(room('kept'))
    await expect(own(kept.generalChannelId).getByTestId('matrix-pair-badge')).toHaveText('Connected')
    await expect(panel.getByTestId('bridge-mode-chooser')).toHaveCount(0)
    await expect(panel.getByTestId('bridge-privacy')).toHaveCount(1)
    await shoot(page, 'matrix-own-program')
  })

  await test.step('its channels and sender mode change as before', async () => {
    await panel.getByTestId('matrix-edit').click()
    await panel.getByTestId('matrix-setup').getByRole('checkbox', { name: /#other/ }).check()
    await panel.getByRole('button', { name: 'Save channels' }).click()
    await expect(panel.getByTestId('matrix-bridge-notice')).toHaveText('2 channels are paired with Matrix.')
    await own(kept.generalChannelId).getByLabel('Harmony members appear in Matrix').selectOption('relay')
    await expect.poll(async () => {
      const { data } = await admin.from('bridge_channels').select('sender_mode, room_id').eq('bot_id', bot.id).eq('channel_id', kept.generalChannelId).single()
      return data
    }).toEqual({ sender_mode: 'relay', room_id: room('kept') })
  })

  await test.step('a managed bridge can be set up beside it, each with its own pairs', async () => {
    await panel.getByTestId('matrix-other-ways').click()
    await panel.getByTestId('choose-self').click()
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'connect')
    await page.reload()
    await expect(panel.locator('.step-panel')).toBeVisible({ timeout: 30000 })
    await expect(panel.getByTestId('matrix-custom').getByTestId('matrix-pair')).toHaveCount(2)
    await expect(panel.getByTestId('matrix-custom').getByTestId('matrix-edit')).toBeVisible()
  })

  await test.step('starting over removes the managed bridge and leaves the program', async () => {
    await panel.getByTestId('start-over').click()
    await page.getByRole('alertdialog', { name: 'Start over?' }).getByRole('button', { name: 'Start over' }).click()
    await expect(panel.getByTestId('matrix-other-ways')).toBeVisible()
    await expect(panel.getByTestId('matrix-pair')).toHaveCount(2)
    expect(await bridgeOf(kept.id)).toBeNull()
  })

  await test.step('unpairing works as before', async () => {
    await panel.getByRole('button', { name: 'Unpair Own Relay from Matrix' }).click()
    await page.getByRole('alertdialog', { name: /Unpair Own Relay/ }).getByRole('button', { name: 'Unpair' }).click()
    await expect(panel.getByTestId('matrix-bridge-notice')).toHaveText('Own Relay is unpaired from Matrix.')
    await expect(panel.getByTestId('matrix-setup')).toBeVisible()
  })

  await admin.from('servers').delete().eq('id', kept.id)
})
