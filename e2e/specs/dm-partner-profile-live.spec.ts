// Journey: a DM partner's new avatar and display name show in the open DM without a reload,
// with no server shared between the two.
//
// broadcast_profile_change (20261118200001) writes profile:updated for the viewer's user topic
// into realtime.messages. Realtime here is scripted (page.routeWebSocket): the e2e stack runs
// none. The script answers joins and heartbeats and forwards the rows the database wrote for the
// viewer's topic as Realtime delivers them: event user_event on realtime:user:<profile id>.
// Avatar URLs are on a host page.route answers with a 1x1 PNG, so no image fails over to the
// default avatar.

import { execFileSync } from 'node:child_process'
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  signIn,
  userClient,
  type SpecUser,
} from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const marker = Date.now().toString(36)
const OLD_AVATAR = `https://avatars.e2e.test/old-${marker}.png`
const NEW_AVATAR = `https://avatars.e2e.test/new-${marker}.png`
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
let viewer: SpecUser
let partner: SpecUser
let conversationId = ''

function sql(query: string): string {
  const project = process.env.E2E_PROJECT || 'hme2e'
  const cid = execFileSync('docker', ['ps', '-q',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=db']).toString().trim()
  if (!cid) throw new Error(`no db container for project ${project}`)
  return execFileSync('docker', ['exec', '-i', cid, 'psql', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-tAc', query]).toString().trim()
}

/** Phoenix frames: vsn 1.0.0 objects, vsn 2.0.0 arrays [join_ref, ref, topic, event, payload]. */
interface Frame {
  topic: string
  event: string
  payload: any
  ref: string | null
  join_ref: string | null
}

class ScriptedRealtime {
  private socket: { ws: WebSocketRoute; array: boolean } | null = null
  readonly joined = new Map<string, string>()
  private forwarded = new Set<string>()

  static async attach(page: Page): Promise<ScriptedRealtime> {
    const fake = new ScriptedRealtime()
    await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => fake.accept(ws))
    return fake
  }

  private accept(ws: WebSocketRoute): void {
    const socket = { ws, array: false }
    this.socket = socket
    this.joined.clear()
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return
      const parsed = JSON.parse(raw)
      socket.array = Array.isArray(parsed)
      const frame: Frame = socket.array
        ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] }
        : parsed
      const reply = () => this.send({ topic: frame.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: frame.ref, join_ref: frame.join_ref })
      if (frame.event === 'phx_join') {
        this.joined.set(frame.topic, String(frame.ref))
        reply()
      } else if (frame.event === 'phx_leave') {
        this.joined.delete(frame.topic)
        reply()
      } else if (frame.event === 'heartbeat') {
        reply()
      }
    })
  }

  private send(frame: Frame): void {
    if (!this.socket) throw new Error('no socket')
    const { ws, array } = this.socket
    ws.send(JSON.stringify(array ? [frame.join_ref, frame.ref, frame.topic, frame.event, frame.payload] : frame))
  }

  /** Delivers the profile:updated rows the database wrote for `topic` since the last call. */
  relayProfileUpdates(topic: string): number {
    const rows = sql(`SELECT id::text || ' ' || event || ' ' || payload::text FROM realtime.messages
                       WHERE topic = '${topic}' AND payload->>'type' = 'profile:updated' ORDER BY inserted_at`)
    let sent = 0
    for (const line of rows.split('\n').filter(Boolean)) {
      const [id, event, ...rest] = line.split(' ')
      if (this.forwarded.has(id)) continue
      this.forwarded.add(id)
      const joinRef = this.joined.get(`realtime:${topic}`)
      if (!joinRef) throw new Error(`realtime:${topic} is not joined`)
      this.send({ topic: `realtime:${topic}`, event: 'broadcast', payload: { type: 'broadcast', event, payload: JSON.parse(rest.join(' ')) }, ref: null, join_ref: joinRef })
      sent++
    }
    return sent
  }
}

test.beforeAll(async () => {
  viewer = await createUser(admin, 'dppv')
  partner = await createUser(admin, 'dppp')
  const avatar = await admin.from('profiles').update({ avatar_url: OLD_AVATAR, display_name: 'Partner before' }).eq('id', partner.id)
  if (avatar.error) throw new Error(`avatar: ${avatar.error.message}`)

  const dm = await admin.from('conversations').insert({ type: 'direct', created_by: partner.id }).select('id').single()
  if (dm.error) throw new Error(`conversation: ${dm.error.message}`)
  conversationId = dm.data.id
  const parts = await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: viewer.id },
    { conversation_id: conversationId, user_id: partner.id },
  ])
  if (parts.error) throw new Error(`participants: ${parts.error.message}`)
  const client = await userClient(partner)
  const sent = await client.from('messages')
    .insert({ conversation_id: conversationId, user_id: partner.id, content: [{ type: 'text', text: `hello ${marker}` }] })
  if (sent.error) throw new Error(`message: ${sent.error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, viewer)
  await deleteUser(admin, partner)
})

test('a DM partner\'s new avatar and name show at once, with no server shared', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('https://avatars.e2e.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  const realtime = await ScriptedRealtime.attach(page)
  const userTopic = `user:${viewer.id}`

  const header = page.locator('.dm-header-container')
  const headerAvatar = header.locator('.conversation-avatar img').first()
  const headerName = header.locator('h2.conversation-name')
  const row = page.locator(`[data-testid="dm-conversation-item"][data-conversation-id="${conversationId}"]`)
  const message = messageList(page).getByRole('article').filter({ hasText: `hello ${marker}` })

  await test.step('the DM shows the partner as they were', async () => {
    await signIn(page, viewer)
    await page.goto(`/dm/${conversationId}`)
    await dismissAnnouncements(page)
    await expect(headerName).toHaveText('Partner before', { timeout: 30_000 })
    await expect(headerAvatar).toHaveAttribute('src', new RegExp(`old-${marker}`))
    await expect(row).toContainText('Partner before')
    await expect(row.locator('img').first()).toHaveAttribute('src', new RegExp(`old-${marker}`))
    await expect(message.locator('.message-avatar img')).toHaveAttribute('src', new RegExp(`old-${marker}`))
    await expect.poll(() => realtime.joined.has(`realtime:${userTopic}`), { timeout: 30_000 }).toBe(true)
    expect([...realtime.joined.keys()].filter((t) => t.startsWith('realtime:server-presence:'))).toEqual([])
  })

  await test.step('the partner changes avatar and name: the database addresses the viewer\'s topic', async () => {
    const { error } = await admin.from('profiles')
      .update({ avatar_url: NEW_AVATAR, display_name: 'Partner after' })
      .eq('id', partner.id)
    if (error) throw new Error(`profile: ${error.message}`)
    expect(realtime.relayProfileUpdates(userTopic)).toBe(1)
  })

  await test.step('header, list and messages show the new avatar and name without a reload', async () => {
    await expect(headerName).toHaveText('Partner after', { timeout: 10_000 })
    await expect(headerAvatar).toHaveAttribute('src', new RegExp(`new-${marker}`))
    await expect(row).toContainText('Partner after')
    await expect(row.locator('img').first()).toHaveAttribute('src', new RegExp(`new-${marker}`))
    await expect(message.locator('.message-avatar img')).toHaveAttribute('src', new RegExp(`new-${marker}`))
  })

  await test.step('a removed avatar leaves the default one', async () => {
    const { error } = await admin.from('profiles').update({ avatar_url: null }).eq('id', partner.id)
    if (error) throw new Error(`profile: ${error.message}`)
    expect(realtime.relayProfileUpdates(userTopic)).toBe(1)
    await expect(headerAvatar).toHaveAttribute('src', /default_avatar/, { timeout: 10_000 })
    await expect(row.locator('img').first()).toHaveAttribute('src', /default_avatar/)
  })
})
