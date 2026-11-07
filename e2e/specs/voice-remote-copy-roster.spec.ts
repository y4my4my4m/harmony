// Journey: the voice roster of a server on another instance. The host's VoiceChannelJoin
// presence leaves a voice_channel_participants row on the copy here
// (VoiceActivityHandler.recordRemotePresence). A member who opens the copy later, after the
// one live broadcast went out, still sees who is in the call: the roster is read from those
// rows when the server opens. When the row goes, so does the entry.
//
// The row is written here as the federation backend writes it; this stack has no federation
// backend or Realtime.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const host = 'voice.example'
let reader: SpecUser
let home: SeededServer
const groupUrl = (id: string) => `https://${host}/servers/${id}`
const copy = { id: crypto.randomUUID(), general: crypto.randomUUID(), voice: crypto.randomUUID() }
const hostOwner = { id: crypto.randomUUID(), username: `vro${Date.now().toString(36)}` }
const caller = { id: crypto.randomUUID(), username: `vrc${Date.now().toString(36)}`, displayName: 'Host Caller' }

async function remoteProfile(p: { id: string; username: string; displayName?: string }) {
  const { error } = await admin.from('profiles').insert({
    id: p.id, username: p.username, display_name: p.displayName ?? p.username, domain: host, is_local: false,
    federated_id: `https://${host}/users/${p.username}`, inbox_url: `https://${host}/users/${p.username}/inbox`,
  })
  if (error) throw new Error(`profile ${p.username}: ${error.message}`)
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'vrr')
  home = await seedServer(admin, reader, `Home ${reader.username}`)
  await remoteProfile(hostOwner)
  await remoteProfile(caller)

  const server = await admin.from('servers').insert({
    id: copy.id, name: `Scobip ${reader.username.slice(-4)}`, owner: hostOwner.id, public: true, is_local_server: false,
    federation_enabled: true, ap_id: groupUrl(copy.id), federation_inbox_url: `${groupUrl(copy.id)}/inbox`, federation_domain: host,
  })
  if (server.error) throw new Error(`remote server: ${server.error.message}`)
  await admin.from('channels').delete().eq('server_id', copy.id)
  const channels = await admin.from('channels').insert([
    { id: copy.general, server_id: copy.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl(copy.id)}/channels/${copy.general}` },
    { id: copy.voice, server_id: copy.id, name: 'voice chat', type: 1, is_remote: true, ap_id: `${groupUrl(copy.id)}/channels/${copy.voice}` },
  ])
  if (channels.error) throw new Error(`remote channels: ${channels.error.message}`)
  const members = await admin.from('user_servers').upsert([
    { server_id: copy.id, user_id: reader.id, status: 'accepted', member_instance: 'localhost' },
    { server_id: copy.id, user_id: caller.id, status: 'accepted', member_instance: host },
  ], { onConflict: 'user_id,server_id' })
  if (members.error) throw new Error(`memberships: ${members.error.message}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().in('id', [copy.id, home?.id].filter(Boolean))
  await admin.from('profiles').delete().in('id', [hostOwner.id, caller.id])
  await deleteUser(admin, reader)
})

/** Answers the federation backend's status check of the copy as its Group would. */
async function answerStatus(page: Page) {
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
}

const listed = (page: Page) =>
  page.locator(`.channel-wrapper[data-channel-id="${copy.voice}"]`).getByTestId(`voice-roster-${caller.id}`)

test('a remote server copy shows who joined its call before the viewer opened it', async ({ page }) => {
  test.setTimeout(120_000)
  await answerStatus(page)
  await signIn(page, reader)
  await openChannel(page, home.id, home.generalChannelId)

  // The host's presence arrives while the reader looks at another server.
  const seat = await admin.from('voice_channel_participants').insert({
    channel_id: copy.voice, server_id: copy.id, user_id: caller.id, joined_at: new Date().toISOString(), is_federated: true,
  })
  if (seat.error) throw new Error(`presence row: ${seat.error.message}`)

  await openChannel(page, copy.id, copy.general)
  await expect(listed(page)).toBeVisible({ timeout: 20_000 })
  await expect(listed(page)).toContainText(caller.displayName)

  // The host's leave removes the row; the next read drops the entry.
  await admin.from('voice_channel_participants').delete().eq('channel_id', copy.voice).eq('user_id', caller.id)
  await openChannel(page, home.id, home.generalChannelId)
  await openChannel(page, copy.id, copy.general)
  await expect(listed(page)).toHaveCount(0, { timeout: 20_000 })
})
