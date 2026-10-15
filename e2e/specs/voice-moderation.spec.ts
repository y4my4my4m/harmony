// Journey: voice moderation (20261017100002_voice_moderation.sql, /api/federation/voice/*).
//
// A moderator (Mute, Deafen and Move Members, Kick Members) server-mutes and server-deafens a
// member from the member's row in the channel list: the member's own mute and deafen lock, the
// soundboard (USE_SOUNDBOARD, and with it USE_EXTERNAL_SOUNDS plays) goes with the microphone,
// all stay locked across leaving and rejoining voice, and unlock when lifted. A member denied
// STREAM in a channel has no camera or Share screen there; one denied SPEAK has a locked mute
// and no soundboard. A member without the permissions gets no moderation items. The moderator drags the member onto another voice channel, one
// the member holds no Connect in: the channel lists them and the member's client follows to
// it, admitted by the move. The moderator then disconnects them from the voice menu, and
// kicks them from it, which takes them out of voice and the server.
//
// The stack has no LiveKit and no realtime: each voice store is set as a joined call leaves
// it, presence rows are written directly, and the moved or removed member's client learns of
// it from my_voice_state, which it polls every 3 s while realtime is down. The federation
// backend runs for the /api/federation/voice routes. Media enforcement in LiveKit is covered
// by federation-backend voiceModeration.test.ts.

import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
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
let member: SpecUser
let lurker: SpecUser
let server: SeededServer
let lounge: string
let annex: string
let stage: string
let quiet: string

// server_roles.permissions bits (src/services/RoleService.ts).
const KICK_MEMBERS = 2 ** 9
const CONNECT = 2 ** 24
const SPEAK = 2 ** 25
const STREAM = 2 ** 26
const MUTE_MEMBERS = 2 ** 27
const DEAFEN_MEMBERS = 2 ** 28
const MOVE_MEMBERS = 2 ** 29

async function addVoiceChannel(name: string): Promise<string> {
  const { data, error } = await admin.from('channels').insert({ server_id: server.id, name, type: 1 }).select('id').single()
  if (error || !data) throw new Error(`voice channel ${name}: ${error?.message}`)
  return data.id
}

async function override(channelId: string, roleId: string, allow: number, deny: number): Promise<void> {
  const { error } = await admin.from('channel_permission_overrides')
    .insert({ channel_id: channelId, target_type: 'role', role_id: roleId, allow_permissions: allow, deny_permissions: deny })
  if (error) throw new Error(`override: ${error.message}`)
}

async function seat(user: SpecUser, channelId: string): Promise<void> {
  await admin.from('voice_channel_participants').delete().eq('server_id', server.id).eq('user_id', user.id)
  const { error } = await admin.from('voice_channel_participants').insert({ channel_id: channelId, server_id: server.id, user_id: user.id })
  if (error) throw new Error(`seat ${user.username}: ${error.message}`)
}

async function seatOf(user: SpecUser): Promise<string | null> {
  const { data } = await admin.from('voice_channel_participants').select('channel_id').eq('server_id', server.id).eq('user_id', user.id)
  return data?.[0]?.channel_id ?? null
}

test.beforeAll(async () => {
  backend = await startBackend()
  owner = await createUser(admin, 'vmo')
  mod = await createUser(admin, 'vmm')
  member = await createUser(admin, 'vmu')
  lurker = await createUser(admin, 'vml')
  server = await seedServer(admin, owner, `Voice mod ${owner.username}`)
  for (const user of [mod, member, lurker]) await addMember(admin, user, server.id)

  const { data: mods, error: roleError } = await admin.from('server_roles').insert({
    server_id: server.id, name: 'mods', position: 5,
    permissions: MUTE_MEMBERS + DEAFEN_MEMBERS + MOVE_MEMBERS + KICK_MEMBERS,
  }).select('id').single()
  if (roleError || !mods) throw new Error(`role: ${roleError?.message}`)
  const { error: assignError } = await admin.from('user_roles').insert({ user_id: mod.id, role_id: mods.id, server_id: server.id })
  if (assignError) throw new Error(`assign: ${assignError.message}`)
  const { data: everyone } = await admin.from('server_roles').select('id').eq('server_id', server.id).eq('is_default', true).single()
  if (!everyone) throw new Error('no @everyone')

  lounge = await addVoiceChannel('lounge')
  annex = await addVoiceChannel('annex')
  stage = await addVoiceChannel('stage')
  quiet = await addVoiceChannel('quiet')
  // annex: members cannot connect; moderators can. stage: nobody streams. quiet: nobody speaks.
  await override(annex, everyone.id, 0, CONNECT)
  await override(annex, mods.id, CONNECT, 0)
  await override(stage, everyone.id, 0, STREAM)
  await override(quiet, everyone.id, 0, SPEAK)
})

test.afterAll(async () => {
  for (const user of [lurker, member, mod, owner]) await deleteUser(admin, user)
  await backend?.stop()
})

/**
 * Signs in on a fresh page whose /api/federation/* requests reach the spawned backend, and
 * opens the server.
 */
async function open(browser: Browser, user: SpecUser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await backend.route(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  return page
}

/** The voice store as a joined call leaves it, and the channel roster presence would deliver. */
async function enterVoice(page: Page, user: SpecUser, channelId: string, roster: SpecUser[]): Promise<void> {
  await page.evaluate(({ serverId, channelId, userId, roster }) => {
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
      s.localState = state(userId)
      s.allUsers = roster.filter((id: string) => id !== userId).map(state)
    })
    stores.get('serverUsers')?.$patch((s) => {
      s.usersInVoiceChannels = { ...s.usersInVoiceChannels, [channelId]: roster }
    })
  }, { serverId: server.id, channelId, userId: user.id, roster: roster.map((u) => u.id) })
}

/** A joined call takes the transport's place: it writes the member's own row, as the client's join does. */
async function stubJoin(page: Page, user: SpecUser): Promise<void> {
  await page.evaluate(({ userId }) => {
    type Store = Record<string, any> & { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const stores = root.__vue_app__.config.globalProperties.$pinia._s
    const voice = stores.get('unifiedVoiceChannel')!
    voice.joinVoiceChannel = async (channelId: string, serverId: string) => {
      voice.$patch((s) => {
        s.isConnected = true
        s.currentServerId = serverId
        s.currentChannelId = channelId
        s.localState.userId = userId
      })
      await stores.get('serverUsers')!.joinVoiceChannel(serverId, channelId, userId, true)
      return true
    }
  }, { userId: user.id })
}

const voiceState = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('#app') as any
  const stores = root.__vue_app__.config.globalProperties.$pinia._s
  const voice = stores.get('unifiedVoiceChannel')
  return {
    connected: voice.isConnected as boolean,
    channelId: voice.currentChannelId as string | null,
    seatSeen: stores.get('voiceModeration')?.seatSeen === true,
  }
})

/** Leaves from the dock; the client's own row delete has landed when this returns. */
async function leaveVoice(page: Page, user: SpecUser): Promise<void> {
  await page.getByTestId('dock-leave').click()
  await expect(page.getByTestId('voice-dock')).toHaveCount(0, { timeout: 15000 })
  await expect.poll(() => seatOf(user), { timeout: 15000 }).toBeNull()
}

const row = (page: Page, user: SpecUser) => page.getByTestId(`voice-participant-${user.id}`)
const soundboardButton = (page: Page) => page.locator('.unified-voice-dock .soundboard-btn')
const channelWrapper = (page: Page, channelId: string) => page.locator(`.channel-wrapper[data-channel-id="${channelId}"]`)

async function openRowMenu(page: Page, user: SpecUser) {
  await row(page, user).click()
  const menu = page.locator('.vcm[role="menu"]')
  await expect(menu).toBeVisible({ timeout: 10000 })
  return menu
}

test('a moderator server-mutes and deafens a member; the member\'s controls lock and stay locked across a rejoin', async ({ browser }) => {
  test.setTimeout(180_000)
  await seat(mod, lounge)
  await seat(member, lounge)
  const modPage = await open(browser, mod)
  const memberPage = await open(browser, member)
  try {
    await enterVoice(memberPage, member, lounge, [mod, member])
    await expect(memberPage.getByTestId('dock-mute')).toBeVisible({ timeout: 30000 })
    await expect(memberPage.getByTestId('dock-mute')).not.toHaveAttribute('data-locked', 'true')
    await expect(soundboardButton(memberPage)).toBeVisible({ timeout: 30000 })

    await enterVoice(modPage, mod, lounge, [mod, member])

    await test.step('the moderator mutes and deafens the member from their row', async () => {
      const menu = await openRowMenu(modPage, member)
      const mute = menu.getByTestId('voice-menu-server-mute')
      await expect(mute).toHaveAttribute('aria-checked', 'false', { timeout: 15000 })
      const muted = modPage.waitForResponse((r) => r.url().includes('/api/federation/voice/moderation') && r.request().method() === 'POST')
      await mute.click()
      expect((await muted).status()).toBe(200)
      await expect(mute).toHaveAttribute('aria-checked', 'true')

      const deafened = modPage.waitForResponse((r) => r.url().includes('/api/federation/voice/moderation'))
      await menu.getByTestId('voice-menu-server-deafen').click()
      expect((await deafened).status()).toBe(200)
      await expect(menu.getByTestId('voice-menu-server-deafen')).toHaveAttribute('aria-checked', 'true')
      await modPage.keyboard.press('Escape')

      await expect(row(modPage, member).getByTestId('voice-row-server-muted')).toHaveCount(1)
      const { data } = await admin.from('server_voice_moderation').select('muted, deafened, muted_by')
        .eq('server_id', server.id).eq('user_id', member.id).single()
      expect(data).toEqual({ muted: true, deafened: true, muted_by: mod.id })
    })

    await test.step('the member\'s mute and deafen lock, and clicking them changes nothing', async () => {
      const muteButton = memberPage.getByTestId('dock-mute')
      await expect(muteButton).toHaveAttribute('data-locked', 'true', { timeout: 15000 })
      await expect(muteButton).toHaveAttribute('aria-pressed', 'true')
      await expect(muteButton).toHaveAttribute('title', /server-muted you|server-deafened you/)
      await expect(memberPage.getByTestId('dock-deafen')).toHaveAttribute('data-locked', 'true')
      await expect(muteButton).toHaveAttribute('aria-disabled', 'true')
      // aria-disabled, not disabled: a click explains the lock instead of acting.
      await muteButton.click({ force: true })
      await expect(memberPage.getByTestId('notification-toasts')).toContainText('A moderator server-deafened you', { timeout: 10000 })
      await memberPage.getByTestId('dock-deafen').click({ force: true })
      await expect(muteButton).toHaveAttribute('aria-pressed', 'true')
      await expect(memberPage.getByTestId('dock-deafen')).toHaveAttribute('aria-pressed', 'true')
      await expect(soundboardButton(memberPage)).toHaveCount(0)
    })

    await test.step('leaving and rejoining voice keeps them locked', async () => {
      await leaveVoice(memberPage, member)
      await seat(member, lounge)
      await enterVoice(memberPage, member, lounge, [mod, member])
      await expect(memberPage.getByTestId('dock-mute')).toHaveAttribute('data-locked', 'true', { timeout: 15000 })
      await expect(memberPage.getByTestId('dock-mute')).toHaveAttribute('aria-pressed', 'true')
      await expect(memberPage.getByTestId('dock-deafen')).toHaveAttribute('data-locked', 'true')
    })

    await test.step('lifting both unlocks the member\'s controls', async () => {
      const menu = await openRowMenu(modPage, member)
      await expect(menu.getByTestId('voice-menu-server-mute')).toHaveAttribute('aria-checked', 'true', { timeout: 15000 })
      await menu.getByTestId('voice-menu-server-mute').click()
      await expect(menu.getByTestId('voice-menu-server-mute')).toHaveAttribute('aria-checked', 'false')
      await menu.getByTestId('voice-menu-server-deafen').click()
      await expect(menu.getByTestId('voice-menu-server-deafen')).toHaveAttribute('aria-checked', 'false')
      await modPage.keyboard.press('Escape')

      const muteButton = memberPage.getByTestId('dock-mute')
      await expect(muteButton).not.toHaveAttribute('data-locked', 'true', { timeout: 15000 })
      await expect(muteButton).toHaveAttribute('aria-pressed', 'false')
      await expect(memberPage.getByTestId('dock-deafen')).toHaveAttribute('aria-pressed', 'false')
      await expect(soundboardButton(memberPage)).toBeVisible({ timeout: 15000 })
      const { data } = await admin.from('server_voice_moderation').select('user_id').eq('server_id', server.id).eq('user_id', member.id)
      expect(data).toEqual([])
    })
  } finally {
    await modPage.context().close()
    await memberPage.context().close()
  }
})

test('without Stream in a channel there is no camera or Share screen; a member without the permissions gets no moderation', async ({ browser }) => {
  test.setTimeout(120_000)
  const page = await open(browser, lurker)
  try {
    await test.step('Stream allowed: camera and Share screen', async () => {
      await enterVoice(page, lurker, lounge, [lurker, member])
      await expect(page.getByTestId('dock-share')).toBeVisible({ timeout: 30000 })
      await expect(page.getByTestId('dock-camera')).toBeVisible()
    })

    await test.step('no moderation items on another member\'s row', async () => {
      const menu = await openRowMenu(page, member)
      await expect(menu.locator('.vcm-check').first()).toBeVisible()
      await expect(menu.getByTestId('voice-menu-moderation')).toHaveCount(0)
      await expect(menu.getByTestId('voice-menu-server-mute')).toHaveCount(0)
      await page.keyboard.press('Escape')
    })

    await test.step('Stream denied: neither, and the keyboard shortcut path refuses too', async () => {
      await leaveVoice(page, lurker)
      await enterVoice(page, lurker, stage, [lurker])
      await expect(page.getByTestId('dock-mute')).toBeVisible({ timeout: 30000 })
      await expect(page.getByTestId('dock-share')).toHaveCount(0, { timeout: 15000 })
      await expect(page.getByTestId('dock-camera')).toHaveCount(0)
      const shared = await page.evaluate(async () => {
        const root = document.querySelector('#app') as any
        const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
        return voice.toggleScreenShare()
      })
      expect(shared).toBe(false)
    })

    await test.step('SPEAK denied: the mute is locked, says why, and there is no soundboard', async () => {
      await leaveVoice(page, lurker)
      await enterVoice(page, lurker, quiet, [lurker])
      const muteButton = page.getByTestId('dock-mute')
      await expect(muteButton).toHaveAttribute('data-locked', 'true', { timeout: 15000 })
      await expect(muteButton).toHaveAttribute('aria-pressed', 'true')
      await expect(muteButton).toHaveAttribute('title', /permission to speak/)
      await expect(page.getByTestId('dock-deafen')).not.toHaveAttribute('data-locked', 'true')
      await expect(soundboardButton(page)).toHaveCount(0)
    })
  } finally {
    await page.context().close()
  }
})

test('a moderator drags a member to another channel, disconnects them, and kicks them from the voice menu', async ({ browser }) => {
  test.setTimeout(240_000)
  await seat(mod, lounge)
  await seat(member, lounge)
  const modPage = await open(browser, mod)
  const memberPage = await open(browser, member)
  try {
    await enterVoice(memberPage, member, lounge, [mod, member])
    await stubJoin(memberPage, member)
    await expect.poll(async () => (await voiceState(memberPage)).seatSeen, { timeout: 20000 }).toBe(true)
    await enterVoice(modPage, mod, lounge, [mod, member])

    await test.step('dragging the member onto annex moves them there, into a channel they cannot connect to', async () => {
      const source = row(modPage, member)
      await expect(source).toBeVisible({ timeout: 30000 })
      await expect(source).toHaveAttribute('aria-describedby', /.+/, { timeout: 15000 })
      const target = channelWrapper(modPage, annex).locator('.channel-row')
      const from = (await source.boundingBox())!
      const to = (await target.boundingBox())!
      const moved = modPage.waitForResponse((r) => r.url().includes('/api/federation/voice/move'))
      await modPage.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await modPage.mouse.down()
      await modPage.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 })
      await expect(modPage.getByTestId('voice-drag-ghost')).toBeVisible()
      await modPage.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
      await expect(channelWrapper(modPage, annex)).toHaveAttribute('data-voice-drop-target', 'true')
      await modPage.mouse.up()
      expect((await moved).status()).toBe(200)

      await expect(channelWrapper(modPage, annex).getByTestId(`voice-roster-${member.id}`)).toBeVisible({ timeout: 10000 })
      expect(await seatOf(member)).toBeNull()
    })

    await test.step('the member\'s client follows to annex and its row lands there under the move grant', async () => {
      await expect.poll(async () => (await voiceState(memberPage)).channelId, { timeout: 20000 }).toBe(annex)
      await expect.poll(() => seatOf(member), { timeout: 20000 }).toBe(annex)
      await expect.poll(async () => (await voiceState(memberPage)).seatSeen, { timeout: 20000 }).toBe(true)
    })

    await test.step('Disconnect from the voice menu takes them out of voice', async () => {
      const rosterRow = channelWrapper(modPage, annex).getByTestId(`voice-roster-${member.id}`).locator('button')
      await rosterRow.click()
      const menu = modPage.locator('.vcm[role="menu"]')
      await expect(menu.getByTestId('voice-menu-disconnect')).toBeVisible({ timeout: 15000 })
      await expect(menu.getByTestId('voice-menu-move')).toBeVisible()
      const disconnected = modPage.waitForResponse((r) => r.url().includes('/api/federation/voice/move'))
      await menu.getByTestId('voice-menu-disconnect').click()
      expect((await disconnected).status()).toBe(200)
      await expect(channelWrapper(modPage, annex).getByTestId(`voice-roster-${member.id}`)).toHaveCount(0)
      expect(await seatOf(member)).toBeNull()
      await expect.poll(async () => (await voiceState(memberPage)).connected, { timeout: 20000 }).toBe(false)
    })

    await test.step('Kick from the voice menu removes them from voice and the server', async () => {
      await seat(member, lounge)
      await enterVoice(memberPage, member, lounge, [mod, member])
      await expect.poll(async () => (await voiceState(memberPage)).seatSeen, { timeout: 20000 }).toBe(true)
      await enterVoice(modPage, mod, lounge, [mod, member])

      const menu = await openRowMenu(modPage, member)
      await menu.getByTestId('voice-menu-kick').click()
      const dialog = modPage.locator('.modal-container[role="dialog"]')
      await expect(dialog).toBeVisible({ timeout: 10000 })
      await dialog.locator('.btn-confirm').click()
      await expect(dialog).toHaveCount(0, { timeout: 15000 })

      const { data: membership } = await admin.from('user_servers').select('status').eq('server_id', server.id).eq('user_id', member.id)
      expect(membership).toEqual([])
      expect(await seatOf(member)).toBeNull()
      await expect.poll(async () => (await voiceState(memberPage)).connected, { timeout: 20000 }).toBe(false)
    })
  } finally {
    await modPage.context().close()
    await memberPage.context().close()
  }
})
