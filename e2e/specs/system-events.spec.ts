// Journey: system notices are authorless events. A join, a kick, a thread, a call and a group
// notice name their people from metadata as clickable names, in the reader's language, and none
// reads as a message its member posted.
//
// A remote server's notice reaches this instance through its channel collection, which the
// federation backend caches as an authorless system row (ServerDiscoveryService). This stack has
// no federation backend: the cached rows are written here as the backend writes them, a join of
// the reader and an ordinary message of the host's owner.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
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
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

// page.route() does not see requests the app's service worker makes.
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let victim: SpecUser
let server: SeededServer
let direct = ''
let group = ''

const host = 'chat.example'
const hostOwner = { id: crypto.randomUUID(), username: `seh${Date.now().toString(36)}`, displayName: 'Host owner' }
const remote = { id: crypto.randomUUID(), name: 'Remote Hall', channel: crypto.randomUUID() }
const groupUrl = `https://${host}/servers/${remote.id}`

const notices = (page: Page) => messageList(page).locator('.system-message')
const notice = (page: Page, text: string) => notices(page).filter({ hasText: text })

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'seo')
  member = await createUser(admin, 'sem')
  victim = await createUser(admin, 'sev')
  server = await seedServer(admin, owner, `Events ${owner.username}`)
  await addMember(admin, member, server.id)
  await addMember(admin, victim, server.id)

  const ownerClient = await userClient(owner)
  const memberClient = await userClient(member)
  await must('kick', ownerClient.rpc('kick_server_member', {
    p_server_id: server.id, p_user_id: victim.id, p_reason: 'spam', p_delete_message_seconds: 0,
  }))
  await must('thread', memberClient.rpc('create_channel_thread', { p_channel_id: server.generalChannelId, p_name: 'Plans' }))

  // A direct conversation with a call nobody answered, and a group the owner created.
  const dm = await must('direct', admin.from('conversations').insert({ type: 'direct', created_by: member.id }).select('id').single())
  direct = dm.data!.id
  await must('direct participants', admin.from('conversation_participants').insert([
    { conversation_id: direct, user_id: owner.id }, { conversation_id: direct, user_id: member.id },
  ]))
  const call = await must('call', memberClient.rpc('start_dm_call_message', { p_conversation_id: direct, p_call_type: 'voice' }))
  await must('call end', memberClient.rpc('finalize_dm_call_message', {
    p_message_id: call.data, p_ended_at: new Date().toISOString(), p_duration_seconds: 0, p_participants: [member.id],
  }))
  const gc = await must('group', admin.from('conversations').insert({ type: 'group', created_by: owner.id }).select('id').single())
  group = gc.data!.id
  await must('group participants', admin.from('conversation_participants').insert([
    { conversation_id: group, user_id: owner.id }, { conversation_id: group, user_id: member.id },
    { conversation_id: group, user_id: victim.id },
  ]))
  await must('group notice', ownerClient.rpc('post_group_conversation_notice', { p_conversation_id: group }))

  // A server on another instance the member belongs to, with its cached channel rows.
  await must('host owner', admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: hostOwner.displayName, domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  }))
  await must('remote server', admin.from('servers').insert({
    id: remote.id, name: remote.name, owner: hostOwner.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host,
  }))
  await admin.from('channels').delete().eq('server_id', remote.id)
  await must('remote channel', admin.from('channels').insert({
    id: remote.channel, server_id: remote.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl}/channels/${remote.channel}`,
  }))
  await must('remote membership', admin.from('user_servers').upsert(
    { server_id: remote.id, user_id: member.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  ))
  const joinedAt = new Date(Date.now() - 60_000).toISOString()
  const joinId = crypto.randomUUID()
  const helloId = crypto.randomUUID()
  await must('cached notice', admin.from('messages').insert({
    id: joinId, channel_id: remote.channel, is_system: true,
    content: [{ type: 'text', text: `${member.displayName} joined the server` }],
    created_at: joinedAt, updated_at: joinedAt, federation_status: 'skipped',
    metadata: { type: 'member_join', subject_id: member.id, ap_id: `https://${host}/messages/${joinId}`, is_remote: true, federated: true },
  }))
  await must('cached message', admin.from('messages').insert({
    id: helloId, channel_id: remote.channel, user_id: hostOwner.id,
    content: [{ type: 'text', text: 'welcome from the host' }], federation_status: 'skipped',
    metadata: { ap_id: `https://${host}/messages/${helloId}`, is_remote: true, federated: true },
  }))
})

test.afterAll(async () => {
  await admin.from('conversations').delete().in('id', [direct, group].filter(Boolean))
  await admin.from('servers').delete().eq('id', remote.id)
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  for (const u of [owner, member, victim]) await deleteUser(admin, u)
})

test('server notices name their people as clickable names, not as authors', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('joins, a kick and a thread read from metadata', async () => {
    await expect(notice(page, `${owner.displayName} joined the server.`)).toHaveCount(1, { timeout: 30000 })
    await expect(notice(page, `${member.displayName} joined the server.`)).toHaveCount(1)
    const kicked = notice(page, `${owner.displayName} kicked ${victim.displayName}.`)
    await expect(kicked).toHaveCount(1)
    await expect(kicked).toContainText('Reason: spam')
    await expect(notice(page, `${member.displayName} started a thread: Plans. See all threads.`)).toHaveCount(1)
    // The stored English content of a known type is never shown.
    await expect(messageList(page).getByText('has joined the server')).toHaveCount(0)
    await expect(messageList(page).getByText('was kicked from the server')).toHaveCount(0)
  })

  await test.step('a notice names its people as buttons; none is a message of theirs', async () => {
    const kicked = notice(page, `${owner.displayName} kicked ${victim.displayName}.`)
    await expect(kicked.getByRole('button', { name: owner.displayName })).toBeVisible()
    await expect(kicked.getByRole('button', { name: victim.displayName })).toBeVisible()
    await expect(messageList(page).locator('.message-header').filter({ hasText: victim.displayName })).toHaveCount(0)

    await kicked.getByRole('button', { name: victim.displayName }).click()
    await expect(page.locator('.profile-modal-content')).toContainText(victim.displayName, { timeout: 15000 })
    await page.locator('.profile-modal-content').getByRole('button', { name: 'Close' }).click()
  })

  await test.step('a notice about the member offers them no report, pin or delete', async () => {
    const joined = notice(page, `${member.displayName} joined the server.`)
    await joined.hover()
    await expect(joined.getByTestId('msg-action-delete')).toHaveCount(0)
    await joined.getByTestId('msg-action-more').click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Report message' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /Pin message/i })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})

test('call and group notices read for the viewer, in the conversation and its preview', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)

  await test.step('the callee reads a missed call from the caller', async () => {
    await page.goto(`/dm/${direct}`)
    await dismissAnnouncements(page)
    await expect(notice(page, `You missed a voice call from ${member.displayName}.`)).toHaveCount(1, { timeout: 30000 })
    await expect(messageList(page).getByText('started a call')).toHaveCount(0)
    await expect(page.locator(`[data-testid="dm-conversation-item"][data-conversation-id="${direct}"]`))
      .toContainText('Missed call')
    await expect(page.locator(`[data-testid="dm-conversation-item"][data-conversation-id="${group}"]`))
      .toContainText('Group created')
  })

  await test.step('the group names its creator and counts its participants', async () => {
    await page.goto(`/dm/${group}`)
    await dismissAnnouncements(page)
    await expect(notice(page, `${owner.displayName} created the group with 3 participants.`)).toHaveCount(1, { timeout: 30000 })
    await expect(messageList(page).getByText('Group conversation created')).toHaveCount(0)
  })
})

test('the caller reads the same call as unanswered', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await page.goto(`/dm/${direct}`)
  await dismissAnnouncements(page)
  const call = notice(page, `${member.displayName} started a voice call.`)
  await expect(call).toHaveCount(1, { timeout: 30000 })
  await expect(call).toContainText('No answer')
})

test('a remote server\'s join notice reads as a system line, not as the member\'s message', async ({ page }) => {
  test.setTimeout(150_000)
  // The federation backend's status check for the remote server, answered as its Group would.
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await signIn(page, member)
  await openChannel(page, remote.id, remote.channel)

  await expect(messageList(page).getByText('welcome from the host')).toBeVisible({ timeout: 30000 })
  const joined = notice(page, `${member.displayName} joined the server.`)
  await expect(joined).toHaveCount(1)
  await expect(joined.getByRole('button', { name: member.displayName })).toBeVisible()
  // The member has no message here: no row carries their name as its author.
  await expect(messageList(page).locator('.message-header').filter({ hasText: member.displayName })).toHaveCount(0)
  await expect(messageList(page).locator('.message-header').filter({ hasText: hostOwner.displayName })).toHaveCount(1)
})
