// Journey: an idle tab's presence costs one presence_heartbeat a minute until it goes Offline,
// then one presence_offline, and nothing else. Before 1.9.4 an Offline tab sent
// presence_offline every minute for as long as it stayed open, every tab posted
// /api/federation/realtime/heartbeat every minute (Redis presence nothing read), and the DM
// list's presence was re-read every minute though DM partners' changes are pushed.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { logRequests } from './funding'

const admin = adminClient()
let me: SpecUser
let partner: SpecUser
let server: SeededServer
let conversation = ''

test.beforeAll(async () => {
  me = await createUser(admin, 'presreq')
  partner = await createUser(admin, 'presreqp')
  server = await seedServer(admin, me, `Presence ${me.username}`)
  const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: me.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  conversation = data.id
  const { error: participantsError } = await admin.from('conversation_participants').insert([
    { conversation_id: conversation, user_id: me.id },
    { conversation_id: conversation, user_id: partner.id },
  ])
  if (participantsError) throw new Error(`participants: ${participantsError.message}`)
})

test.afterAll(async () => {
  if (conversation) await admin.from('conversations').delete().eq('id', conversation)
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, partner)
  await deleteUser(admin, me)
})

test('twenty idle minutes: heartbeats until Offline, one presence_offline, no Redis heartbeat or presence polling', async ({ page }) => {
  test.setTimeout(240_000)
  // Timers run on a clock the test advances: twenty idle minutes pass in seconds.
  await page.clock.install()
  const heartbeat = logRequests(page, /\/rpc\/presence_heartbeat$/)
  const offline = logRequests(page, /\/rpc\/presence_offline$/)
  const getPresence = logRequests(page, /\/rpc\/get_presence$/)
  const redis = logRequests(page, /\/api\/federation\/realtime\//)

  await signIn(page, me)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(messageList(page)).toBeVisible()
  await page.waitForTimeout(3_000)
  heartbeat.take()
  offline.take()
  getPresence.take()
  expect(redis.take()).toEqual([])

  for (let minute = 0; minute < 20; minute++) {
    await page.clock.runFor(60_000)
    await page.waitForTimeout(400)
  }

  // ActivityTracker: Offline after 15 idle minutes.
  expect(offline.take()).toEqual(['POST /rest/v1/rpc/presence_offline'])
  const beats = heartbeat.take().length
  expect(beats).toBeGreaterThanOrEqual(13)
  expect(beats).toBeLessThanOrEqual(16)
  expect(getPresence.take()).toEqual([])
  expect(redis.take()).toEqual([])
})
