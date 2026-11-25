// Journey: the instance's own Matrix bridge. An instance admin opens Instance admin → Config →
// General → Matrix bridge: the bridge service that was never seen shows the command that starts it,
// on the Discord card too, and the command goes once it was seen; the bridge is set up as an
// application service, the registration file is downloaded once and kept nowhere in the page, a
// changed account name asks for a new one, a new one is warned about, and the switch and the limits
// are saved. Then a manager chooses it, gets a code for a channel, is told whom to invite and what to
// post, and sees the pair the code made. Another server's code moves the room there: the first
// server's card says so and takes a new code. The bridge host is played by the service role
// (bridge_host_report, matrix_bridge_link_room, matrix_bridge_report_status).

import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { addChannel, adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, userClient, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
const BRIDGE_USER = '@harmony_relay:matrix.e2e.example'
let staff: SpecUser
let owner: SpecUser
let rival: SpecUser
let server: SeededServer
let rivalServer: SeededServer
let secretId = ''
const KEYS = ['matrix_bridge_instance_enabled', 'matrix_bridge_instance_limit', 'matrix_bridge_hosting_enabled', 'matrix_bridge_hosting_limit']
const before = new Map<string, unknown>()

const readConfig = async (key: string) => {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).maybeSingle()
  return data?.config_value
}
const room = () => `!plaza${owner.username.slice(-6)}:matrix.e2e.example`

async function bridgeOf(serverId: string) {
  const { data, error } = await admin.from('matrix_bridges').select('id, bot_id, mode').eq('server_id', serverId).single()
  if (error) throw new Error(`bridge: ${error.message}`)
  return data as { id: string; bot_id: string; mode: string }
}

/** POST /bridge/v2/matrix/host/status as the gateway stores it. */
async function hostReport(platform: 'discord' | 'matrix', problems: unknown[] = []) {
  const { error } = await admin.rpc('bridge_host_report', {
    p_platform: platform,
    p_version: platform === 'matrix' ? '0.3.0' : null,
    p_status: platform === 'matrix' ? { hosted: 0, instance: { ready: problems.length === 0, user_id: BRIDGE_USER, server_name: 'matrix.e2e.example', problems } } : null,
  })
  if (error) throw new Error(`host: ${error.message}`)
}

/** POST /bridge/v2/matrix/status of one bridge. */
async function report(serverId: string, pairs: unknown[] = []) {
  const { error } = await admin.rpc('matrix_bridge_report_status', {
    p_bot_id: (await bridgeOf(serverId)).bot_id,
    p_connection: 'application_service',
    p_status: { ready: true, user_id: BRIDGE_USER, homeserver: 'https://matrix.e2e.example', server_name: 'matrix.e2e.example', pending: 0, failed: 0, problems: [] },
    p_snapshot: { rooms: [{ room_id: room(), name: 'The Plaza', alias: '#plaza:matrix.e2e.example', encrypted: false, can_send: true, members: 8, invited: false }] },
    p_version: '0.3.0',
    p_pairs: pairs,
  })
  if (error) throw new Error(`report: ${error.message}`)
}

/** POST /bridge/v2/matrix/host/link: what the bridge does when the command is posted in the room. */
async function postInRoom(command: string) {
  const code = command.replace(/^!harmony link /, '')
  const { data, error } = await admin.rpc('matrix_bridge_link_room', { p_code: code, p_room_id: room(), p_sender: '@mod:matrix.e2e.example' })
  if (error) throw new Error(`link: ${error.message}`)
  return data as { channel_id: string } | null
}

async function openMatrixTab(page: Page, serverId: string) {
  await page.goto(`/server/${serverId}?section=bridges&tab=matrix`)
  await dismissAnnouncements(page)
  const panel = page.getByTestId('bridges-panel-matrix')
  await expect(panel.getByTestId('matrix-bridge')).toBeVisible({ timeout: 30000 })
  return panel
}

const copied = async (panel: Locator, testId: string) => (await panel.getByTestId(testId).locator('pre').innerText()).trim()

test.use({ viewport: { width: 1440, height: 900 } })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  staff = await createUser(admin, 'mxstaff')
  const { error } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (error) throw new Error(`promote: ${error.message}`)
  owner = await createUser(admin, 'mxinst')
  rival = await createUser(admin, 'mxrival')
  server = await seedServer(admin, owner, `Instance ${owner.username.slice(-6)}`)
  rivalServer = await seedServer(admin, rival, `Rival ${rival.username.slice(-6)}`)
  secretId = await addChannel(admin, server, 'secret')
  for (const [table, row] of [
    ['server_encryption_settings', { server_id: server.id, encryption_mode: 'optional' }],
    ['channel_encryption_settings', { channel_id: secretId, messages_encrypted: true }],
  ] as const) {
    const { error: seedError } = await admin.from(table).upsert(row)
    if (seedError) throw new Error(`${table}: ${seedError.message}`)
  }
  for (const key of KEYS) before.set(key, await readConfig(key))
  for (const key of KEYS.filter((k) => k.endsWith('_enabled'))) await admin.from('instance_config').update({ config_value: false }).eq('config_key', key)
  await admin.from('bridge_hosts').delete().in('platform', ['discord', 'matrix'])
  await admin.from('matrix_bridge_instance').delete().eq('id', true)
})

test.afterAll(async () => {
  await admin.from('matrix_bridge_instance').delete().eq('id', true)
  await admin.from('bridge_hosts').delete().in('platform', ['discord', 'matrix'])
  for (const [key, value] of before) await admin.from('instance_config').update({ config_value: value }).eq('config_key', key)
  await admin.from('servers').delete().in('id', [server?.id, rivalServer?.id].filter(Boolean))
  for (const user of [owner, rival, staff]) await deleteUser(admin, user)
})

test('an instance admin sets the bridge up, gets its registration once, and offers it', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, staff)
  await page.goto('/admin?tab=config')
  const card = page.getByTestId('matrix-admin-section')
  const discordCard = page.getByTestId('bridge-admin-section')
  const saved = page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Matrix bridge settings saved' })

  await test.step('a service that was never seen shows the command that starts it, on both cards', async () => {
    await expect(card).toBeVisible({ timeout: 45000 })
    await expect(card.getByRole('heading', { name: 'Matrix bridge', exact: true })).toBeVisible()
    await expect(card.getByTestId('service-seen')).toHaveText("The service hasn't connected yet.")
    await expect(card.getByTestId('service-command').locator('pre')).toHaveText('harmony bridges add matrix')
    await expect(card.getByTestId('service-command').getByTestId('copy-button')).toBeVisible()
    await expect(discordCard.getByTestId('service-command').locator('pre')).toHaveText('harmony bridges add discord')
  })

  await test.step('the bridge is set up as an application service; what is missing is refused', async () => {
    await expect(card.getByTestId('matrix-instance-summary')).toContainText('No bridge set up yet.')
    await expect(card.getByTestId('matrix-instance-save')).toBeDisabled()
    await card.getByLabel('Homeserver address').fill('synapse')
    await expect(card).toContainText('Enter an address such as https://matrix.example.org.')
    await card.getByLabel('Homeserver address').fill('http://synapse:8008')
    await card.getByLabel('Server name').fill('matrix.e2e.example')
    await card.getByTestId('matrix-instance-save').click()
    await expect(saved.first()).toBeVisible({ timeout: 20000 })
    await expect(card.getByTestId('matrix-instance-senderLocalpart')).toHaveValue('harmony_relay')
    await expect(card.getByTestId('matrix-instance-appserviceUrl')).toHaveValue(/\/matrix-appservice$/)
    await expect(card.getByTestId('matrix-instance-registration-state')).toHaveText('Not made yet')
    await expect(card.getByTestId('matrix-instance-enabled')).toHaveAttribute('aria-disabled', 'true')
  })

  let first: Record<string, unknown> = {}
  await test.step('the registration is downloaded and is nowhere in the page', async () => {
    const download = page.waitForEvent('download')
    await card.getByRole('button', { name: 'Make the registration file' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('registration.json')
    first = JSON.parse(fs.readFileSync((await file.path())!, 'utf8'))
    expect(first).toMatchObject({ id: 'harmony-matrix-relay', sender_localpart: 'harmony_relay', rate_limited: false })
    expect(first.as_token).toMatch(/^[0-9a-f]{64}$/)
    await expect(card.getByTestId('matrix-instance-registration-state')).toHaveText('Made')
    await expect(card.getByTestId('matrix-instance-summary')).toContainText('Bridge set up: matrix.e2e.example.')
    const page1 = await page.evaluate(() => JSON.stringify({ html: document.documentElement.outerHTML, local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(page1).not.toContain(first.as_token as string)
    expect(page1).not.toContain(first.hs_token as string)
  })

  await test.step('a changed account name asks for a new file, which is warned about and replaces the tokens', async () => {
    await card.getByTestId('matrix-instance-senderLocalpart').fill('harmony_bridge')
    await card.getByTestId('matrix-instance-save').click()
    await expect(card.getByTestId('matrix-instance-registration-stale')).toBeVisible({ timeout: 20000 })
    await card.getByRole('button', { name: 'Make a new registration file' }).click()
    const warning = card.getByTestId('matrix-instance-confirm')
    await expect(warning).toContainText('The bridge stops until the homeserver has the new file.')
    const download = page.waitForEvent('download')
    await warning.getByRole('button', { name: 'Make a new registration file' }).click()
    const second = JSON.parse(fs.readFileSync((await (await download).path())!, 'utf8'))
    expect(second.sender_localpart).toBe('harmony_bridge')
    expect(second.as_token).not.toBe(first.as_token)
    await expect(card.getByTestId('matrix-instance-registration-stale')).toHaveCount(0)
  })

  await test.step('the switch and the limits are saved', async () => {
    await card.getByTestId('matrix-instance-enabled').click()
    await expect.poll(() => readConfig('matrix_bridge_instance_enabled')).toBe(true)
    await card.getByTestId('matrix-instance-limit').fill('40')
    await card.getByTestId('matrix-instance-save-limit').click()
    await expect.poll(() => readConfig('matrix_bridge_instance_limit')).toBe(40)
    await expect(card.getByTestId('matrix-instance-count')).toContainText('of 40.')
    const hosting = card.getByTestId('bridge-hosting-admin')
    await hosting.getByTestId('hosting-toggle').click()
    await expect.poll(() => readConfig('matrix_bridge_hosting_enabled')).toBe(true)
    expect(await readConfig('discord_bridge_hosting_enabled')).not.toBe(true)
    await hosting.getByTestId('hosting-limit').fill('3')
    await hosting.getByTestId('hosting-save').click()
    await expect.poll(() => readConfig('matrix_bridge_hosting_limit')).toBe(3)
    await expect(hosting.getByTestId('hosting-count')).toContainText('of 3.')
  })

  await test.step('a service that was seen shows when, its version and its problems, and no command', async () => {
    await hostReport('matrix', [{ code: 'matrix_registration_missing' }])
    await hostReport('discord')
    await page.reload()
    await expect(card.getByTestId('service-seen')).toContainText('Last heard from', { timeout: 45000 })
    await expect(card.getByTestId('service-version')).toHaveText('version 0.3.0')
    await expect(card.getByTestId('service-problems')).toContainText('Give it the registration file and restart it.')
    await expect(card.getByTestId('service-command')).toHaveCount(0)
    await expect(discordCard.getByTestId('service-seen')).toContainText('Last heard from')
    await expect(discordCard.getByTestId('service-command')).toHaveCount(0)
  })

  await test.step('one silent for more than five minutes shows the command again', async () => {
    await admin.from('bridge_hosts').update({ last_seen_at: new Date(Date.now() - 6 * 60_000).toISOString() }).eq('platform', 'matrix')
    await page.reload()
    await expect(card.getByTestId('service-command').locator('pre')).toHaveText('harmony bridges add matrix', { timeout: 45000 })
    await expect(discordCard.getByTestId('service-command')).toHaveCount(0)
    await hostReport('matrix')
  })
})

test('a manager links a room by a code, and a code of another server moves it away', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  const panel = await openMatrixTab(page, server.id)
  const pairCard = panel.locator(`[data-testid="matrix-managed-pair"][data-channel="${server.generalChannelId}"]`)

  await test.step("the instance's bridge is first and recommended", async () => {
    const articles = panel.getByTestId('bridge-mode-chooser').getByRole('article')
    await expect(articles.first()).toHaveAttribute('data-testid', 'mode-instance')
    await expect(articles.first()).toContainText('Recommended')
    await panel.getByTestId('choose-instance').click()
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'check')
    await expect(panel.getByTestId('check-waiting')).toContainText('Waiting for this instance to start your bridge')
    expect((await bridgeOf(server.id)).mode).toBe('instance')
  })

  await test.step('a code names the account to invite and the message to post', async () => {
    await report(server.id)
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'channels', { timeout: 15000 })
    await expect(panel.getByTestId('select-room')).toHaveCount(0)
    await expect(panel.getByLabel('Harmony channel').getByRole('option', { name: '#secret (end-to-end encrypted)' })).toBeDisabled()
    await panel.getByLabel('Harmony channel').selectOption(server.generalChannelId)
    await panel.getByTestId('select-direction').selectOption('to_harmony')
    await panel.getByRole('button', { name: 'Get a code' }).click()
    expect(await copied(panel, 'matrix-code-account')).toBe(BRIDGE_USER)
    expect(await copied(panel, 'matrix-code-command')).toMatch(/^!harmony link ML-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    await expect(panel.getByTestId('matrix-code-expiry')).toHaveText('expires in 30 minutes')
    await expect(panel.getByTestId('matrix-code-panel')).toContainText("Only someone who may change the room's settings can link it")
  })

  await test.step('a new code takes the place of the first', async () => {
    const first = await copied(panel, 'matrix-code-command')
    await panel.getByTestId('new-room-code').click()
    await expect(panel.getByTestId('matrix-code-command').locator('pre')).not.toHaveText(first)
    expect(await postInRoom(first)).toBeNull()
  })

  await test.step('the pair appears by itself once the message is posted', async () => {
    expect(await postInRoom(await copied(panel, 'matrix-code-command'))).toMatchObject({ channel_id: server.generalChannelId })
    await expect(panel.getByTestId('matrix-linked')).toHaveText('#general is linked with The Plaza.', { timeout: 15000 })
    await expect(panel.getByTestId('matrix-code-panel')).toHaveCount(0)
    await expect(pairCard.getByTestId('matrix-pair-room')).toHaveText('The Plaza')
    await expect(pairCard).toContainText('#plaza:matrix.e2e.example')
    await report(server.id, [{ channel_id: server.generalChannelId, state: 'ready' }])
    await expect(pairCard.getByTestId('matrix-pair-badge')).toHaveText('Working', { timeout: 15000 })
    await panel.getByRole('button', { name: 'Finish setup' }).click()
    await expect(panel.getByTestId('status-mode')).toHaveText("With this instance's Matrix bridge")
    await expect(panel.getByTestId('matrix-maintain')).toHaveCount(0)
  })

  await test.step('its direction is changed with the room it has', async () => {
    await pairCard.getByLabel('Direction').selectOption('both')
    await expect.poll(async () => {
      const { data } = await admin.from('bridge_channels').select('direction, room_id').eq('bot_id', (await bridgeOf(server.id)).bot_id).single()
      return data
    }).toEqual({ direction: 'both', room_id: room() })
  })

  await test.step("another server's code moves the room there", async () => {
    const rivalClient = await userClient(rival)
    const created = await rivalClient.rpc('matrix_bridge_create', { p_server_id: rivalServer.id, p_mode: 'instance' })
    if (created.error) throw new Error(`rival: ${created.error.message}`)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const rivalPage = await context.newPage()
    await signIn(rivalPage, rival)
    await report(rivalServer.id)
    const rivalPanel = await openMatrixTab(rivalPage, rivalServer.id)
    await rivalPanel.getByLabel('Harmony channel').selectOption(rivalServer.generalChannelId)
    await rivalPanel.getByRole('button', { name: 'Get a code' }).click()
    expect(await postInRoom(await copied(rivalPanel, 'matrix-code-command'))).toMatchObject({ channel_id: rivalServer.generalChannelId })
    await expect(rivalPanel.getByTestId('matrix-linked')).toBeVisible({ timeout: 15000 })
    await context.close()
  })

  await test.step('the card of the server that lost it says so and takes a new code', async () => {
    await expect(pairCard.getByTestId('matrix-pair-error')).toHaveText(
      'The room was linked with another channel by a newer code. Link #general again with a code of its own.',
      { timeout: 15000 },
    )
    await expect(pairCard.getByTestId('matrix-pair-badge')).toHaveText('Not working')
    await expect(panel.getByTestId('status-title')).toHaveText('Bridge is online, with problems')
    await pairCard.getByRole('button', { name: 'Link a room again' }).click()
    await expect(panel.getByLabel('Harmony channel')).toHaveValue(server.generalChannelId)
    await panel.getByRole('button', { name: 'Get a code' }).click()
    await postInRoom(await copied(panel, 'matrix-code-command'))
    await expect(panel.getByTestId('matrix-linked')).toHaveText('#general is linked with The Plaza.', { timeout: 15000 })
    await expect(pairCard.getByTestId('matrix-pair-error')).toHaveCount(0)
  })

  await test.step('disconnecting leaves nothing of the server on the bridge', async () => {
    await panel.getByRole('button', { name: 'Disconnect bridge' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Disconnect the bridge?' })
    await expect(dialog).not.toContainText('docker')
    await dialog.getByRole('button', { name: 'Disconnect' }).click()
    await expect(panel.getByTestId('bridge-mode-chooser')).toBeVisible()
    const { data } = await admin.from('matrix_bridges').select('id').eq('server_id', server.id)
    expect(data).toEqual([])
  })
})
