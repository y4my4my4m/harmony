// Journey: a voice channel on another instance refuses the join. The host's
// harmony:VoiceChannelJoinReject reaches the client as federated_voice:rejected: the toast names
// the reason well before the 20 s timeout, the caller leaves the channel's roster, and another
// try sends another join. Only the answer naming the pending join counts.
//
// Admin › Config › Voice & video states federated calls as the backend reports them
// (GET /api/livekit/config), with no switch, and a save of the tab leaves the stored flag alone.
//
// This stack has no federation backend or Realtime: the routes answer as the backend does, and an
// event is handed to the client's user event channel.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, dismissAnnouncements, openChannel, signIn, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const host = 'refusing.example'
const REASON = 'Not authorized for this room'
const groupUrl = (id: string) => `https://${host}/servers/${id}`
const copy = { id: crypto.randomUUID(), general: crypto.randomUUID(), voice: crypto.randomUUID() }
const hostOwner = { id: crypto.randomUUID(), username: `vjr${Date.now().toString(36)}` }
let reader: SpecUser
let staff: SpecUser

test.beforeAll(async () => {
  reader = await createUser(admin, 'vjm')
  staff = await createUser(admin, 'vja')
  const promoted = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (promoted.error) throw new Error(`staff: ${promoted.error.message}`)

  const profile = await admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: hostOwner.username, domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  })
  if (profile.error) throw new Error(`profile: ${profile.error.message}`)
  const server = await admin.from('servers').insert({
    id: copy.id, name: `Refusing ${reader.username.slice(-4)}`, owner: hostOwner.id, public: true, is_local_server: false,
    federation_enabled: true, ap_id: groupUrl(copy.id), federation_inbox_url: `${groupUrl(copy.id)}/inbox`, federation_domain: host,
  })
  if (server.error) throw new Error(`remote server: ${server.error.message}`)
  await admin.from('channels').delete().eq('server_id', copy.id)
  const channels = await admin.from('channels').insert([
    { id: copy.general, server_id: copy.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl(copy.id)}/channels/${copy.general}` },
    { id: copy.voice, server_id: copy.id, name: 'voice chat', type: 1, is_remote: true, ap_id: `${groupUrl(copy.id)}/channels/${copy.voice}` },
  ])
  if (channels.error) throw new Error(`remote channels: ${channels.error.message}`)
  const member = await admin.from('user_servers').upsert(
    { server_id: copy.id, user_id: reader.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  )
  if (member.error) throw new Error(`membership: ${member.error.message}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', copy.id)
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  await deleteUser(admin, reader)
  await deleteUser(admin, staff)
})

/** What realtime would deliver on user:<self>, handed to the client's user event channel. */
async function userEvent(page: Page, payload: Record<string, unknown>): Promise<void> {
  const dispatched = await page.evaluate(async (payload) => {
    const url = performance.getEntriesByType('resource').map((e) => e.name)
      .find((name) => name.includes('/src/services/UserEventChannel.ts'))
    if (!url) return false
    const channel = (await import(/* @vite-ignore */ url)).userEventChannel as any
    if (!channel.handlers.get(payload.type)?.size) return false
    channel.dispatch(payload)
    return true
  }, payload)
  expect(dispatched, `a handler for ${payload.type}`).toBe(true)
}

const voiceStore = (page: Page) => page.evaluate((channelId) => {
  const pinia = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia
  const voice = pinia._s.get('unifiedVoiceChannel')
  return {
    connecting: voice.isConnecting as boolean,
    connected: voice.isConnected as boolean,
    roster: [...(pinia._s.get('serverUsers').usersInVoiceChannels[channelId] ?? [])] as string[],
  }
}, copy.voice)

test('a refused join says why at once, leaves the roster and can be tried again', async ({ page }) => {
  test.setTimeout(120_000)
  const joins: string[] = []
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await page.route('**/api/federation/voice/join', (route) => {
    const joinId = `https://localhost/users/${reader.username}/activities/voice-join/${crypto.randomUUID()}`
    joins.push(joinId)
    return route.fulfill({ json: { success: true, joinId, serverHost: host } })
  })

  await signIn(page, reader)
  await openChannel(page, copy.id, copy.general)

  // A click during the sidebar's first render can be lost.
  const join = async (seen: number) => {
    await expect(async () => {
      if (joins.length === seen) await page.locator(`[data-nav-kind="channel"][data-nav-id="${copy.voice}"]`).click()
      await expect.poll(() => joins.length, { timeout: 5_000 }).toBeGreaterThan(seen)
    }).toPass({ timeout: 45_000 })
    await expect.poll(async () => (await voiceStore(page)).roster).toContain(reader.id)
  }

  await join(0)

  // Answers to anything else leave the join pending.
  await userEvent(page, { type: 'federated_voice:rejected', originalJoinId: 'https://evil.example/x', serverHost: host, reason: 'forged' })
  await userEvent(page, { type: 'federated_voice:rejected', originalJoinId: joins[0], serverHost: 'evil.example', reason: 'forged' })
  expect((await voiceStore(page)).connecting).toBe(true)
  await expect(page.getByText('Could not join voice')).toHaveCount(0)

  const refused = Date.now()
  await userEvent(page, { type: 'federated_voice:rejected', originalJoinId: joins[0], serverHost: host, reason: REASON })
  await expect(page.getByText('Could not join voice')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText(REASON)).toBeVisible()
  expect(Date.now() - refused).toBeLessThan(10_000)

  await expect.poll(async () => (await voiceStore(page)).roster).not.toContain(reader.id)
  await expect(page.locator(`.channel-wrapper[data-channel-id="${copy.voice}"]`).getByTestId(`voice-roster-${reader.id}`)).toHaveCount(0)
  const after = await voiceStore(page)
  expect(after.connecting).toBe(false)
  expect(after.connected).toBe(false)
  await expect(page.getByTestId('dock-mute')).toHaveCount(0)

  // Another try is a new join under a new id; its refusal counts on its own.
  await join(1)
  expect(joins[1]).not.toBe(joins[0])
  await userEvent(page, { type: 'federated_voice:rejected', originalJoinId: joins[1], serverHost: host, reason: 'Voice is not available on this server' })
  await expect(page.getByText('Voice is not available on this server')).toBeVisible({ timeout: 5_000 })
  await expect.poll(async () => (await voiceStore(page)).roster).not.toContain(reader.id)
})

test('the voice tab states federated calls as the backend reports them, with no switch', async ({ page }) => {
  test.setTimeout(120_000)
  const stored = await admin.from('instance_webrtc_settings').select('id, webrtc_mode, allow_federated_voice').limit(1).maybeSingle()
  if (stored.error || !stored.data) throw new Error(`voice settings: ${stored.error?.message ?? 'no row'}`)
  const pinned = await admin.from('instance_webrtc_settings').update({ allow_federated_voice: false, webrtc_mode: 'hybrid' }).eq('id', stored.data.id)
  if (pinned.error) throw new Error(`voice settings: ${pinned.error.message}`)

  try {
    let answer: { status: number; json: Record<string, unknown> } = {
      status: 200,
      json: { enabled: true, mode: 'hybrid', wsUrl: 'wss://live.example', allowFederatedVoice: true },
    }
    await page.route('**/api/livekit/config', (route) => route.fulfill(answer))

    await signIn(page, staff)
    await page.goto('/admin?tab=config')
    await dismissAnnouncements(page)
    const voiceTab = page.locator('.config-tab-btn').filter({ hasText: 'Voice & video' })
    const otherTab = page.locator('.config-tab-btn').filter({ hasText: 'Federation' })
    const row = page.getByTestId('webrtc-federated-state')

    await voiceTab.click()
    await expect(row).toContainText('On. People from other instances can join voice channels and calls here.', { timeout: 15_000 })
    await expect(row).toContainText('ALLOW_FEDERATED_VOICE')
    await expect(row.locator('input')).toHaveCount(0)
    await expect(page.getByText('Allow federated voice calls')).toHaveCount(0)

    answer = { status: 200, json: { ...answer.json, allowFederatedVoice: false } }
    await otherTab.click()
    await voiceTab.click()
    await expect(row).toContainText('Off. People from other instances are refused and told so.')

    answer = { status: 200, json: { enabled: false, mode: 'hybrid', wsUrl: null, allowFederatedVoice: true } }
    await otherTab.click()
    await voiceTab.click()
    await expect(row).toContainText('Off. This instance has no LiveKit server.')

    answer = { status: 500, json: {} }
    await otherTab.click()
    await voiceTab.click()
    await expect(row).toContainText('The current state could not be read.')

    // The tab's other values still save; the stored flag stays as it was.
    await page.locator('.config-section').filter({ hasText: 'WebRTC / voice settings' }).locator('select').selectOption('sfu')
    await page.locator('.config-section').filter({ hasText: 'WebRTC / voice settings' }).getByRole('button', { name: 'Save changes' }).click()
    await expect.poll(async () => {
      const { data } = await admin.from('instance_webrtc_settings').select('webrtc_mode, allow_federated_voice').eq('id', stored.data!.id).single()
      return data
    }, { timeout: 15_000 }).toEqual({ webrtc_mode: 'sfu', allow_federated_voice: false })
  } finally {
    await admin.from('instance_webrtc_settings').update({
      webrtc_mode: stored.data.webrtc_mode, allow_federated_voice: stored.data.allow_federated_voice,
    }).eq('id', stored.data.id)
  }
})
