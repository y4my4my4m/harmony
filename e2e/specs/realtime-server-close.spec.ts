// Journey: Realtime closes every channel the page holds (a `phx_close` per topic, as the events
// limit or an expired token sends), and each topic is joined again on the same socket without a
// reload. The structure topic, once back, shows a channel created while it was closed and then
// delivers a new one.
//
// Realtime here is FakeRealtime: the e2e stack runs none. A real Realtime sends these closes when
// a socket's access token expires: `system` "Token has expired" and `phx_close` on every topic.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  addChannel,
  channelRow,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { FakeRealtime } from './fakeRealtime'

const admin = adminClient()
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  member = await createUser(admin, 'rtclose')
  server = await seedServer(admin, member, `Close ${member.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
})

// Topics a member viewing a server text channel holds.
const viewTopics = (s: SeededServer, profileId: string) => [
  `realtime:user:${profileId}`,
  `realtime:dm-calls:${profileId}`,
  `realtime:server-structure:${s.id}`,
  `realtime:server-presence:${s.id}`,
  `realtime:voice-channels:${s.id}`,
  `realtime:channel-messages-${s.generalChannelId}`,
  `realtime:typing:channel:${s.generalChannelId}`,
]

test('every topic Realtime closes is joined again without a reload', async ({ page }) => {
  test.setTimeout(180_000)
  const fake = await FakeRealtime.attach(page)
  const topics = viewTopics(server, member.id)
  const structure = `realtime:server-structure:${server.id}`

  await test.step('open a server channel: the page joins its topics', async () => {
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await expect.poll(() => topics.filter((t) => fake.joined.has(t)), { timeout: 30_000 }).toEqual(topics)
  })

  const socketsBefore = fake.socketCount
  const joinsBefore = new Map(topics.map((t) => [t, fake.joinsOf(t).length]))
  const gapName = `gap-${member.username.slice(-6)}`

  await test.step('Realtime closes every topic; a channel is created meanwhile', async () => {
    for (const topic of topics) fake.closeChannel(topic)
    await addChannel(admin, server, gapName)
  })

  await test.step('each topic is joined again on the same socket', async () => {
    // Longest wait: 5 s doubling, plus up to half again.
    await expect.poll(() => topics.filter((t) => fake.joinsOf(t).length <= joinsBefore.get(t)!), { timeout: 20_000 }).toEqual([])
    await expect.poll(() => topics.filter((t) => !fake.joined.has(t)), { timeout: 5_000 }).toEqual([])
    expect(fake.socketCount).toBe(socketsBefore)
    const states = await page.evaluate(async () => {
      const { supabase } = await import('/src/supabase.ts')
      return Object.fromEntries(supabase.getChannels().map((c) => [c.topic, c.state]))
    })
    for (const topic of topics) expect(states[topic], topic).toBe('joined')
  })

  await test.step('the structure topic shows what it missed, then delivers', async () => {
    await expect(channelRow(page, gapName)).toBeVisible({ timeout: 15_000 })

    const liveName = `live-${member.username.slice(-6)}`
    const id = await addChannel(admin, server, liveName)
    const { data: row } = await admin.from('channels').select('*').eq('id', id).single()
    fake.broadcast(structure, 'server_event', { type: 'channel:insert', new: row })
    await expect(channelRow(page, liveName)).toBeVisible({ timeout: 5_000 })
  })
})
