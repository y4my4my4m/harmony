// Journey: Discord people of a bridged channel as the bot gateway's member list
// (/bot-gateway/bridged-users) describes them, whenever its answer lands.
//  - A reply names a Discord person in the colour of their own message header: their highest
//    coloured Discord role, answered here only after the reply has rendered.
//  - A channel's late answer never fills the member list of the channel opened since.
//  - Opening another server empties the bridged list before that server's answer.
//  - The member search takes a Discord person's whole id, not some of its digits.
//
// The stack runs no bot gateway: rows are written with the service role, as the gateway does,
// and the member list is a routed answer.

import { test, expect } from '@playwright/test'
import {
  addChannel,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let botId = ''
let quietChannelId = ''
let otherServer: SeededServer

const DANA = { id: '1400000000000000103', username: 'dana', display_name: 'Dana' }
const ORANGE = 'rgb(230, 126, 34)'

test.beforeAll(async () => {
  owner = await createUser(admin, 'brc')
  server = await seedServer(admin, owner, `Reply colours ${owner.username}`)

  const { data: bot, error: botError } = await admin
    .from('bots')
    .insert({ username: `bridge_${owner.username}`.slice(0, 32), display_name: 'Discord Bridge', owner_id: owner.id, is_public: false, bot_type: 'bridge' })
    .select('id')
    .single()
  if (botError || !bot) throw new Error(`bot: ${botError?.message}`)
  botId = bot.id
  const { error: bridgeError } = await admin
    .from('discord_bridges')
    .insert({ server_id: server.id, bot_id: botId, mode: 'self', discord_guild_id: '900000000000000778', created_by: owner.id })
  if (bridgeError) throw new Error(`bridge: ${bridgeError.message}`)

  const { data: danaMessage, error: danaError } = await admin
    .from('messages')
    .insert({
      channel_id: server.generalChannelId,
      bot_id: botId,
      content: [{ type: 'text', text: 'Bridged from Discord' }],
      metadata: { bot: true, bridge_source: 'discord', discord_message_id: '1400000000000000104', discord_user: DANA },
    })
    .select('id')
    .single()
  if (danaError || !danaMessage) throw new Error(`dana: ${danaError?.message}`)

  const { error: replyError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    reply_to: danaMessage.id,
    content: [{ type: 'text', text: 'Answering Dana' }],
  })
  if (replyError) throw new Error(`reply: ${replyError.message}`)
  quietChannelId = await addChannel(admin, server, 'quiet')
  otherServer = await seedServer(admin, owner, `Next door ${owner.username}`)
})

test.afterAll(async () => {
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  if (botId) await admin.from('bots').delete().eq('id', botId)
  await deleteUser(admin, owner)
})

test('a reply colours a Discord author as their message does, once the member list arrives', async ({ page }) => {
  test.setTimeout(150_000)
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/bot-gateway/bridged-users/**', async (route) => {
    await released
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        has_bridge: true,
        users: [{
          id: DANA.id,
          username: DANA.username,
          displayName: DANA.display_name,
          avatarUrl: '',
          source: 'discord',
          harmonyRoleIds: [],
          roles: [
            { id: 'r-mods', name: 'Mods', color: '#e67e22', position: 2 },
            { id: 'r-booster', name: 'Booster', color: '#f47fff', position: 1 },
          ],
        }],
      }),
    })
  })

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)

  const list = page.locator('[data-testid="message-list"]')
  const header = list.locator('.message-item').filter({ hasText: 'Bridged from Discord' }).locator('.username').first()
  const quoted = list.locator('.message-item').filter({ hasText: 'Answering Dana' }).locator('.reply-reference .reply-username')
  await expect(quoted).toHaveText(/Dana/, { timeout: 30000 })
  await expect(header).toBeVisible()
  // Rendered before the member list: neither name has a role colour, and the reply is not Discord blurple.
  await expect(quoted).not.toHaveCSS('color', 'rgb(88, 101, 242)')
  await expect(quoted).not.toHaveCSS('color', ORANGE)

  release()
  await expect(header).toHaveCSS('color', ORANGE, { timeout: 15000 })
  await expect(quoted).toHaveCSS('color', ORANGE, { timeout: 15000 })
})

test('a bridged channel answering late leaves the member list of the channel opened since', async ({ page }) => {
  test.setTimeout(150_000)
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let quietAnswered = false
  await page.route(`**/bot-gateway/bridged-users/${server.generalChannelId}`, async (route) => {
    await released
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        has_bridge: true,
        users: [{ id: DANA.id, username: DANA.username, displayName: DANA.display_name, avatarUrl: '', source: 'discord', presenceStatus: 'online', harmonyRoleIds: [], customStatus: null }],
      }),
    })
  })
  await page.route(`**/bot-gateway/bridged-users/${quietChannelId}`, async (route) => {
    quietAnswered = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ has_bridge: false, users: [] }) })
  })

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await channelRow(page, 'quiet').click()
  await expect(page).toHaveURL(new RegExp(`/${quietChannelId}$`))
  await expect.poll(() => quietAnswered, { timeout: 15000 }).toBe(true)

  // general's answer lands after #quiet's: Dana never joins the list of #quiet.
  const generalAnswer = page.waitForResponse((response) => response.url().endsWith(`/bridged-users/${server.generalChannelId}`))
  release()
  await (await generalAnswer).finished()
  // The app has read the body and painted.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const bridgedRows = page.locator('.user-sidebar .user-item.bridged-user')
  await expect(page.locator('.user-sidebar')).toBeVisible()
  await expect(bridgedRows).toHaveCount(0)

  // Back in #general, its own answer shows her.
  await channelRow(page, 'general').click()
  await expect(bridgedRows.filter({ hasText: DANA.display_name })).toHaveCount(1, { timeout: 15000 })
})

test('opening another server empties the bridged list before its answer', async ({ page }) => {
  test.setTimeout(150_000)
  const EVE = { ...DANA, id: '1500000000000000201', username: 'eve', display_name: 'Eve' }
  const answer = (person: typeof DANA) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      has_bridge: true,
      users: [{ id: person.id, username: person.username, displayName: person.display_name, avatarUrl: '', source: 'discord', presenceStatus: 'online', harmonyRoleIds: [], customStatus: null }],
    }),
  })
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let nextAsked = false
  await page.route(`**/bot-gateway/bridged-users/${server.generalChannelId}`, (route) => route.fulfill(answer(DANA)))
  await page.route(`**/bot-gateway/bridged-users/${otherServer.generalChannelId}`, async (route) => {
    nextAsked = true
    await released
    await route.fulfill(answer(EVE))
  })

  const sidebar = page.locator('.user-sidebar')
  const bridgedRows = sidebar.locator('.user-item.bridged-user')
  const openServer = (name: string) => page.locator('#app-server-rail').locator(`[aria-label*="${name}"]`).first().click()

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(bridgedRows.filter({ hasText: DANA.display_name })).toHaveCount(1, { timeout: 15000 })

  await test.step('some digits of a Discord id find nobody, the whole id finds its person', async () => {
    const search = page.getByTestId('member-search')
    await search.fill('1400')
    await expect(bridgedRows).toHaveCount(0)
    await search.fill(DANA.id)
    await expect(bridgedRows.filter({ hasText: DANA.display_name })).toHaveCount(1)
    await search.fill('')
  })

  await test.step('the next server lists nobody until its own answer', async () => {
    await openServer(`Next door ${owner.username}`)
    await expect(page).toHaveURL(new RegExp(`/${otherServer.id}/${otherServer.generalChannelId}$`), { timeout: 15000 })
    await expect.poll(() => nextAsked, { timeout: 15000 }).toBe(true)
    await expect(bridgedRows).toHaveCount(0)
    release()
    await expect(bridgedRows.filter({ hasText: EVE.display_name })).toHaveCount(1, { timeout: 15000 })
    await expect(bridgedRows).toHaveCount(1)
  })

  await test.step('switching back lists the first server\'s person only', async () => {
    await openServer(`Reply colours ${owner.username}`)
    await expect(page).toHaveURL(new RegExp(`/${server.id}/`), { timeout: 15000 })
    await expect(bridgedRows.filter({ hasText: DANA.display_name })).toHaveCount(1, { timeout: 15000 })
    await expect(bridgedRows).toHaveCount(1)
  })
})
