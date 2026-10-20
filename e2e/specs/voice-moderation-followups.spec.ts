// Journey: voice moderation follow-ups (20261017100005_voice_moderation_followups.sql).
//
// Mute, Deafen and Move Members decide alone, as in Discord: a moderator whose role ranks
// below a member, the owner or themself is offered the voice items for them and acts, and is
// offered no Kick. A server mute ends with membership: a member who leaves and rejoins speaks.
// Losing Speak in the channel locks a connected P2P member's microphone at once, and losing
// Connect takes them out of voice, from the voice-grants broadcast the change makes. A remote
// server's Group moves its member: the member's client joins the destination through that
// server's host; the Group's server mute, stored in the copy, locks the member's controls.
//
// The stack has no LiveKit and no realtime: voice stores are set as a joined call leaves them,
// and the broadcasts and user events realtime would carry are handed to the client's own
// handlers. The federation backend runs for the /api/federation/voice routes; the remote
// host's answers to a voice join are stubbed.

import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBackend, type Backend } from './backend'

test.describe.configure({ mode: 'serial' })
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let backend: Backend
let owner: SpecUser
let mod: SpecUser
let boss: SpecUser
let member: SpecUser
let server: SeededServer
let lounge: string
let everyoneRole: string
let copy: string
let copyLounge: string
let copyAnnex: string

// server_roles.permissions bits (src/services/RoleService.ts).
const KICK_MEMBERS = 2 ** 9
const CONNECT = 2 ** 24
const SPEAK = 2 ** 25
const MUTE_MEMBERS = 2 ** 27
const DEAFEN_MEMBERS = 2 ** 28
const MOVE_MEMBERS = 2 ** 29

async function seat(user: SpecUser, channelId: string, serverId = server.id): Promise<void> {
  await admin.from('voice_channel_participants').delete().eq('server_id', serverId).eq('user_id', user.id)
  const { error } = await admin.from('voice_channel_participants').insert({ channel_id: channelId, server_id: serverId, user_id: user.id })
  if (error) throw new Error(`seat ${user.username}: ${error.message}`)
}

test.beforeAll(async () => {
  // Starts the federation backend under tsx: past 30 s on a loaded CI runner.
  test.setTimeout(120_000)
  backend = await startBackend()
  owner = await createUser(admin, 'vfo')
  mod = await createUser(admin, 'vfm')
  boss = await createUser(admin, 'vfb')
  member = await createUser(admin, 'vfu')
  server = await seedServer(admin, owner, `Voice followups ${owner.username}`)
  for (const user of [mod, boss, member]) await addMember(admin, user, server.id)

  const roles = await admin.from('server_roles').insert([
    { server_id: server.id, name: 'mods', position: 1, permissions: MUTE_MEMBERS + DEAFEN_MEMBERS + MOVE_MEMBERS + KICK_MEMBERS },
    { server_id: server.id, name: 'boss', position: 9, permissions: 0 },
  ]).select('id, name')
  if (roles.error || !roles.data) throw new Error(`roles: ${roles.error?.message}`)
  const roleId = (name: string) => roles.data!.find((r) => r.name === name)!.id
  const assigned = await admin.from('user_roles').insert([
    { user_id: mod.id, role_id: roleId('mods'), server_id: server.id },
    { user_id: boss.id, role_id: roleId('boss'), server_id: server.id },
  ])
  if (assigned.error) throw new Error(`assign: ${assigned.error.message}`)
  const { data: everyone } = await admin.from('server_roles').select('id').eq('server_id', server.id).eq('is_default', true).single()
  if (!everyone) throw new Error('no @everyone')
  everyoneRole = everyone.id

  const { data: channel, error: channelError } = await admin.from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1 }).select('id').single()
  if (channelError || !channel) throw new Error(`lounge: ${channelError?.message}`)
  lounge = channel.id

  // A remote server's copy, as a join leaves it.
  const group = `https://remote.example/servers/${crypto.randomUUID()}`
  const { data: copied, error: copyError } = await admin.from('servers').insert({
    name: `Remote ${owner.username}`, owner: owner.id, public: false, is_local_server: false, federation_enabled: true,
    ap_id: group, federation_inbox_url: `${group}/inbox`, host_domain: 'remote.example', federation_domain: 'remote.example',
  }).select('id').single()
  if (copyError || !copied) throw new Error(`copy: ${copyError?.message}`)
  copy = copied.id
  await addMember(admin, member, copy)
  const voiceChannels = await admin.from('channels').insert([
    { server_id: copy, name: 'remote-lounge', type: 1, is_remote: true },
    { server_id: copy, name: 'remote-annex', type: 1, is_remote: true },
  ]).select('id, name')
  if (voiceChannels.error || !voiceChannels.data) throw new Error(`copy channels: ${voiceChannels.error?.message}`)
  copyLounge = voiceChannels.data.find((c) => c.name === 'remote-lounge')!.id
  copyAnnex = voiceChannels.data.find((c) => c.name === 'remote-annex')!.id
})

test.afterAll(async () => {
  if (copy) await admin.from('servers').delete().eq('id', copy)
  for (const user of [member, boss, mod, owner]) await deleteUser(admin, user)
  await backend?.stop()
})

async function open(browser: Browser, user: SpecUser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await backend.route(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  return page
}

/** The voice store as a joined call leaves it, and the channel roster presence would deliver. */
async function enterVoice(
  page: Page,
  user: SpecUser,
  channelId: string,
  roster: SpecUser[],
  call: { serverId?: string; federated?: boolean; mode?: 'p2p' | 'livekit' } = {},
): Promise<void> {
  await page.evaluate(({ serverId, channelId, userId, roster, federated, mode }) => {
    type Store = Record<string, any> & { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const stores = root.__vue_app__.config.globalProperties.$pinia._s
    const voice = stores.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    const state = (id: string) => ({
      userId: id, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
      isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
    })
    voice.$patch((s) => {
      s.isConnected = true
      s.currentServerId = serverId
      s.currentChannelId = channelId
      s.currentChannelName = 'voice'
      s.isFederatedChannel = federated
      s.connectionMode = mode
      s.localState = state(userId)
      s.allUsers = roster.filter((id: string) => id !== userId).map(state)
    })
    stores.get('serverUsers')?.$patch((s) => {
      s.usersInVoiceChannels = { ...s.usersInVoiceChannels, [channelId]: roster }
    })
  }, {
    serverId: call.serverId ?? server.id, channelId, userId: user.id, roster: roster.map((u) => u.id),
    federated: call.federated === true, mode: call.mode ?? 'p2p',
  })
}

/** What realtime would deliver on voice-channels:<server>, handed to the client's handler. */
async function voiceChannelEvent(page: Page, serverId: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ serverId, payload }) => {
    const root = document.querySelector('#app') as any
    root.__vue_app__.config.globalProperties.$pinia._s.get('serverUsers').handleVoiceChannelEvent(serverId, payload)
  }, { serverId, payload })
}

/**
 * What realtime would deliver on user:<self>, handed to the client's user event channel: the
 * module instance the app loaded, by the URL Vite served it under, once the voice moderation
 * host that handles it is mounted.
 */
async function userEvent(page: Page, payload: Record<string, unknown>): Promise<void> {
  const run = (dispatch: boolean) => page.evaluate(async ({ payload, dispatch }) => {
    const url = performance.getEntriesByType('resource').map((e) => e.name)
      .find((name) => name.includes('/src/services/UserEventChannel.ts'))
    if (!url) return 0
    const channel = (await import(/* @vite-ignore */ url)).userEventChannel as any
    const handlers = channel.handlers.get(payload.type)?.size ?? 0
    if (dispatch && handlers > 0) channel.dispatch(payload)
    return handlers
  }, { payload, dispatch })
  await expect.poll(() => run(false), { timeout: 15000, message: `a handler for ${payload.type}` }).toBeGreaterThan(0)
  await run(true)
}

const voiceState = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('#app') as any
  const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
  return { connected: voice.isConnected as boolean, channelId: voice.currentChannelId as string | null }
})

const row = (page: Page, user: SpecUser) => page.getByTestId(`voice-participant-${user.id}`)

async function openRowMenu(page: Page, user: SpecUser) {
  await row(page, user).click()
  const menu = page.locator('.vcm[role="menu"]')
  await expect(menu).toBeVisible({ timeout: 10000 })
  return menu
}

async function flags(serverId: string, user: SpecUser) {
  const { data } = await admin.from('server_voice_moderation').select('muted, deafened, muted_by, deafened_by')
    .eq('server_id', serverId).eq('user_id', user.id).maybeSingle()
  return data
}

test('Mute, Deafen and Move Members ignore role order: a moderator acts on a higher role, the owner and themself; Kick does not', async ({ browser }) => {
  test.setTimeout(180_000)
  for (const user of [mod, boss, owner]) await seat(user, lounge)
  const page = await open(browser, mod)
  try {
    await enterVoice(page, mod, lounge, [mod, boss, owner])

    await test.step('a member ranked above the moderator', async () => {
      const menu = await openRowMenu(page, boss)
      await expect(menu.getByTestId('voice-menu-server-mute')).toBeVisible({ timeout: 15000 })
      await expect(menu.getByTestId('voice-menu-server-deafen')).toBeVisible()
      await expect(menu.getByTestId('voice-menu-disconnect')).toBeVisible()
      await expect(menu.getByTestId('voice-menu-kick')).toHaveCount(0)
      const muted = page.waitForResponse((r) => r.url().includes('/api/federation/voice/moderation') && r.request().method() === 'POST')
      await menu.getByTestId('voice-menu-server-mute').click()
      expect((await muted).status()).toBe(200)
      await expect(menu.getByTestId('voice-menu-server-mute')).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('Escape')
      expect(await flags(server.id, boss)).toMatchObject({ muted: true, muted_by: mod.id })
    })

    await test.step('the owner', async () => {
      const menu = await openRowMenu(page, owner)
      await expect(menu.getByTestId('voice-menu-server-deafen')).toBeVisible({ timeout: 15000 })
      await expect(menu.getByTestId('voice-menu-kick')).toHaveCount(0)
      const deafened = page.waitForResponse((r) => r.url().includes('/api/federation/voice/moderation'))
      await menu.getByTestId('voice-menu-server-deafen').click()
      expect((await deafened).status()).toBe(200)
      await page.keyboard.press('Escape')
      expect(await flags(server.id, owner)).toMatchObject({ deafened: true, deafened_by: mod.id })
    })

    await test.step('themself', async () => {
      const menu = await openRowMenu(page, mod)
      await expect(menu.getByTestId('voice-menu-server-mute')).toBeVisible({ timeout: 15000 })
      await expect(menu.getByTestId('voice-menu-disconnect')).toBeVisible()
      await expect(menu.getByTestId('voice-menu-kick')).toHaveCount(0)
      await expect(menu.getByTestId('voice-menu-ban')).toHaveCount(0)
      await page.keyboard.press('Escape')
    })
  } finally {
    await admin.from('server_voice_moderation').delete().eq('server_id', server.id)
    await admin.from('voice_channel_participants').delete().eq('server_id', server.id)
    await page.context().close()
  }
})

test('a server mute ends with membership: the member who leaves and rejoins is not muted', async ({ browser }) => {
  test.setTimeout(120_000)
  const asMod = await userClient(mod)
  const { error } = await asMod.rpc('set_server_voice_state', { p_server_id: server.id, p_user_id: member.id, p_mute: true, p_deafen: true })
  expect(error).toBeNull()
  expect(await flags(server.id, member)).toMatchObject({ muted: true, deafened: true })

  await admin.from('user_servers').delete().eq('server_id', server.id).eq('user_id', member.id)
  expect(await flags(server.id, member)).toBeNull()
  await addMember(admin, member, server.id)
  expect(await flags(server.id, member)).toBeNull()

  await seat(member, lounge)
  const page = await open(browser, member)
  try {
    await enterVoice(page, member, lounge, [member])
    const muteButton = page.getByTestId('dock-mute')
    await expect(muteButton).toBeVisible({ timeout: 30000 })
    await expect(muteButton).not.toHaveAttribute('data-locked', 'true')
    await expect(page.getByTestId('dock-deafen')).not.toHaveAttribute('data-locked', 'true')
  } finally {
    await admin.from('voice_channel_participants').delete().eq('server_id', server.id)
    await page.context().close()
  }
})

test('losing Speak locks a connected P2P member\'s microphone at once; losing Connect takes them out', async ({ browser }) => {
  test.setTimeout(120_000)
  await seat(member, lounge)
  const page = await open(browser, member)
  try {
    await enterVoice(page, member, lounge, [member])
    const muteButton = page.getByTestId('dock-mute')
    await expect(muteButton).toBeVisible({ timeout: 30000 })
    await expect(muteButton).not.toHaveAttribute('data-locked', 'true')

    await test.step('a Speak deny on the channel', async () => {
      await admin.from('voice_grant_resyncs').delete().eq('server_id', server.id)
      const { error } = await admin.from('channel_permission_overrides')
        .insert({ channel_id: lounge, target_type: 'role', role_id: everyoneRole, allow_permissions: 0, deny_permissions: SPEAK })
      expect(error).toBeNull()
      const { data: queued } = await admin.from('voice_grant_resyncs').select('channel_id, user_id').eq('server_id', server.id)
      expect(queued).toEqual([{ channel_id: lounge, user_id: null }])
      await voiceChannelEvent(page, server.id, { event: 'voice-grants', serverId: server.id, channelId: lounge, userId: null })
      await expect(muteButton).toHaveAttribute('data-locked', 'true', { timeout: 15000 })
      await expect(muteButton).toHaveAttribute('aria-pressed', 'true')
      await expect(muteButton).toHaveAttribute('title', /permission to speak/)
    })

    await test.step('a Connect deny as well', async () => {
      const { error } = await admin.from('channel_permission_overrides').update({ deny_permissions: SPEAK + CONNECT })
        .eq('channel_id', lounge).eq('role_id', everyoneRole)
      expect(error).toBeNull()
      await voiceChannelEvent(page, server.id, { event: 'voice-grants', serverId: server.id, channelId: lounge, userId: null })
      await expect.poll(async () => (await voiceState(page)).connected, { timeout: 20000 }).toBe(false)
      await expect(page.getByTestId('notification-toasts')).toContainText('You no longer have access to that voice channel', { timeout: 10000 })
    })
  } finally {
    await admin.from('channel_permission_overrides').delete().eq('channel_id', lounge)
    await admin.from('voice_channel_participants').delete().eq('server_id', server.id)
    await admin.from('voice_grant_resyncs').delete().eq('server_id', server.id)
    await page.context().close()
  }
})

test('a remote server\'s Group moves its member: the client joins the destination through the host; its server mute locks the controls', async ({ browser }) => {
  test.setTimeout(120_000)
  const page = await open(browser, member)
  const joins: Array<Record<string, unknown>> = []
  await page.route('**/api/federation/voice/join', async (route) => {
    joins.push(JSON.parse(route.request().postData() ?? '{}'))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ joinId: 'join-1', serverHost: 'remote.example' }) })
  })
  await page.route('**/api/federation/voice/leave', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  try {
    await test.step('the Group\'s move is followed through the host', async () => {
      await enterVoice(page, member, copyLounge, [member], { serverId: copy, federated: true, mode: 'livekit' })
      await userEvent(page, { type: 'voice:moved', server_id: copy, from_channel_id: copyLounge, channel_id: copyAnnex, reason: 'moved' })
      await expect.poll(() => joins.length, { timeout: 15000 }).toBe(1)
      expect(joins[0]).toEqual({ channelId: copyAnnex, serverId: copy })
      await expect(page.getByTestId('notification-toasts')).toContainText('Moved to another channel', { timeout: 10000 })
      // The stubbed host never answers with a token: the pending join is cancelled.
      await page.evaluate(async () => {
        const root = document.querySelector('#app') as any
        await root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel').leaveVoiceChannel()
      })
      await expect.poll(() => page.evaluate(() => {
        const root = document.querySelector('#app') as any
        return root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel').isConnecting as boolean
      }), { timeout: 10000 }).toBe(false)
    })

    await test.step('the Group\'s disconnect takes the client out', async () => {
      await enterVoice(page, member, copyAnnex, [member], { serverId: copy, federated: true, mode: 'livekit' })
      await userEvent(page, { type: 'voice:moved', server_id: copy, from_channel_id: copyAnnex, channel_id: null, reason: 'disconnected' })
      await expect.poll(async () => (await voiceState(page)).connected, { timeout: 15000 }).toBe(false)
    })

    await test.step('the Group\'s server mute, stored in the copy, locks the member\'s controls', async () => {
      const { data: changed, error } = await admin.rpc('apply_group_voice_state', {
        p_server_id: copy, p_user_id: member.id, p_muted: true, p_deafened: false,
      })
      expect(error).toBeNull()
      expect(changed).toBe(true)
      await enterVoice(page, member, copyLounge, [member], { serverId: copy, federated: true, mode: 'livekit' })
      const muteButton = page.getByTestId('dock-mute')
      await expect(muteButton).toHaveAttribute('data-locked', 'true', { timeout: 15000 })
      await expect(muteButton).toHaveAttribute('title', /server-muted you/)
      await userEvent(page, { type: 'voice:moderation', server_id: copy, muted: false, deafened: false })
      await expect(muteButton).not.toHaveAttribute('data-locked', 'true', { timeout: 15000 })
    })
  } finally {
    await admin.from('server_voice_moderation').delete().eq('server_id', copy)
    await page.context().close()
  }
})
