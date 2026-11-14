// Journeys on the token Realtime is handed when getSession() returns no session.
//
// 1. The token refresh fails on the network while a member views a server channel. auth-js
//    keeps the stored session and retries; getSession() meanwhile returns no session. The page's
//    Realtime topics stay joined on the member's token through a heartbeat and a socket drop, and
//    once the refresh succeeds the structure topic delivers a channel created after it.
// 2. Realtime is handed the anon key: the open channel's message topic and the user topic close,
//    their rejoin is refused. The next refresh's member token joins both again without a reload,
//    and a message sent after it reaches the open channel.
// 3. Another tab signs out and its logout request fails, so the stored session is removed without
//    auth-js. This tab signs out as well: its sidebar and user panel go, and its own topics join
//    nothing on the anon key after a socket drop.
//
// Realtime here is scripted (page.routeWebSocket): the e2e stack runs none. Like Realtime
// v2.148.3 it refuses a private join, and stops a joined private topic on an access_token push,
// when the token carries no `sub` (the anon key). A join without access_token is authorized
// with the socket's apikey parameter, the anon key.

import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
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

interface Frame {
  topic: string
  event: string
  payload: any
  ref: string | null
  join_ref: string | null
}

interface TokenFrame {
  kind: 'join' | 'access_token'
  topic: string
  token: string | null
  at: number
}

function subOf(token: string | null): string | null {
  if (!token) return null
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub ?? null
  } catch {
    return null
  }
}

/** Phoenix frames: vsn 1.0.0 objects, vsn 2.0.0 arrays [join_ref, ref, topic, event, payload]. */
class TokenCheckingRealtime {
  private sockets: Array<{ ws: WebSocketRoute; array: boolean; apikey: string | null }> = []
  readonly tokens: TokenFrame[] = []
  /** Topic to the join ref and socket it is joined on. */
  readonly joined = new Map<string, { ref: string; socket: number; private: boolean }>()

  static async attach(page: Page): Promise<TokenCheckingRealtime> {
    const fake = new TokenCheckingRealtime()
    await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => fake.accept(ws))
    return fake
  }

  get socketCount(): number {
    return this.sockets.length
  }

  private accept(ws: WebSocketRoute): void {
    const socket = { ws, array: false, apikey: new URL(ws.url()).searchParams.get('apikey') }
    const index = this.sockets.push(socket) - 1
    this.joined.clear()
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return
      const parsed = JSON.parse(raw)
      socket.array = Array.isArray(parsed)
      const frame: Frame = socket.array
        ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] }
        : parsed
      const reply = (status: 'ok' | 'error', response: Record<string, unknown> = {}) =>
        this.send(index, { topic: frame.topic, event: 'phx_reply', payload: { status, response }, ref: frame.ref, join_ref: frame.join_ref })

      if (frame.event === 'heartbeat') {
        reply('ok')
      } else if (frame.event === 'phx_leave') {
        this.joined.delete(frame.topic)
        reply('ok')
      } else if (frame.event === 'phx_join') {
        const token = frame.payload?.access_token ?? socket.apikey
        const isPrivate = frame.payload?.config?.private === true
        this.tokens.push({ kind: 'join', topic: frame.topic, token: frame.payload?.access_token ?? null, at: Date.now() })
        if (isPrivate && !subOf(token)) {
          reply('error', { reason: `Unauthorized: You do not have permissions to read from this Channel topic: ${frame.topic.replace(/^realtime:/, '')}` })
          return
        }
        this.joined.set(frame.topic, { ref: String(frame.ref), socket: index, private: isPrivate })
        reply('ok')
      } else if (frame.event === 'access_token') {
        const token = frame.payload?.access_token ?? null
        this.tokens.push({ kind: 'access_token', topic: frame.topic, token, at: Date.now() })
        const join = this.joined.get(frame.topic)
        if (join?.private && token && !subOf(token)) {
          this.joined.delete(frame.topic)
          const sub = frame.topic.replace(/^realtime:/, '')
          this.send(index, { topic: frame.topic, event: 'system', payload: { extension: 'system', status: 'error', message: `You do not have permissions to read from this Channel topic: ${sub}`, channel: sub }, ref: null, join_ref: join.ref })
          this.send(index, { topic: frame.topic, event: 'phx_close', payload: {}, ref: join.ref, join_ref: join.ref })
        }
      }
    })
  }

  private send(index: number, frame: Frame): void {
    const { ws, array } = this.sockets[index]
    ws.send(JSON.stringify(array ? [frame.join_ref, frame.ref, frame.topic, frame.event, frame.payload] : frame))
  }

  /** Drops the newest socket, as a network change or a sleeping device does. */
  dropSocket(): void {
    this.sockets[this.sockets.length - 1].ws.close({ code: 1006 })
  }

  broadcast(topic: string, event: string, payload: Record<string, unknown>): void {
    const join = this.joined.get(topic)
    if (!join) throw new Error(`${topic} is not joined`)
    this.send(join.socket, { topic, event: 'broadcast', payload: { type: 'broadcast', event, payload }, ref: null, join_ref: join.ref })
  }

  /** Joins and access_token pushes since `since` whose token Realtime would not accept. */
  rejectedSince(since: number): string[] {
    return this.tokens.filter((f) => f.at >= since && !subOf(f.token)).map((f) => `${f.kind} ${f.topic} ${f.token ? 'anon' : 'apikey'}`)
  }
}

const admin = adminClient()
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  member = await createUser(admin, 'rtrefresh')
  server = await seedServer(admin, member, `Refresh ${member.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
})

const refreshRoute = '**/auth/v1/token?grant_type=refresh_token*'

/** auth-js reads the stored session on every getSession(); an expired one makes it refresh. */
async function expireStoredSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k))
    if (!key) throw new Error('no stored session')
    const stored = JSON.parse(localStorage.getItem(key)!)
    stored.expires_at = Math.floor(Date.now() / 1000) - 30
    localStorage.setItem(key, JSON.stringify(stored))
  })
}

test('a failed token refresh keeps the Realtime topics on the member token', async ({ page }) => {
  test.setTimeout(360_000)
  const fake = await TokenCheckingRealtime.attach(page)
  const topics = [
    `realtime:user:${member.id}`,
    `realtime:dm-calls:${member.id}`,
    `realtime:server-structure:${server.id}`,
    `realtime:voice-channels:${server.id}`,
  ]
  const structure = `realtime:server-structure:${server.id}`

  await test.step('open a server channel: its private topics join on the member token', async () => {
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await expect.poll(() => topics.filter((t) => !fake.joined.has(t)), { timeout: 30_000 }).toEqual([])
    expect(fake.rejectedSince(0)).toEqual([])
  })

  const failedAt = Date.now()

  await test.step('the refresh fails on the network; a heartbeat re-reads the token', async () => {
    // Records each answer of Realtime's token callback, unchanged.
    await page.evaluate(async () => {
      const { supabase } = await import('/src/supabase.ts')
      const realtime = supabase.realtime as unknown as { accessToken: () => Promise<string | null> }
      const answer = realtime.accessToken
      const answers: Array<{ at: number; token: string | null }> = []
      ;(window as any).__realtimeTokenAnswers = answers
      realtime.accessToken = async () => {
        const token = await answer()
        answers.push({ at: Date.now(), token })
        return token
      }
    })
    let refreshAttempts = 0
    await page.route(refreshRoute, (route) => {
      refreshAttempts++
      return route.abort('internetdisconnected')
    })
    await expireStoredSession(page)
    const expiredAt = await page.evaluate(() => Date.now())
    // realtime-js asks after every heartbeat (25 s). With the stored session expired, each ask
    // runs a refresh that auth-js retries for up to 30 s (AUTO_REFRESH_TICK_DURATION_MS) before
    // getSession() answers no session with the error; asks queue on its lock behind the page's
    // other getSession() calls. An answer recorded 2 s past the expiry ran in that state.
    const answered = () => page.evaluate((at) => (window as any).__realtimeTokenAnswers
      .filter((a: { at: number }) => a.at > at).map((a: { token: string | null }) => a.token), expiredAt + 2_000)
    await expect.poll(async () => (await answered()).length, { timeout: 180_000, intervals: [2_000] }).toBeGreaterThan(0)
    expect(refreshAttempts).toBeGreaterThan(0)
    for (const token of await answered()) expect(subOf(token)).toBe(member.id)
    await page.waitForTimeout(1_000)
    expect(fake.rejectedSince(failedAt)).toEqual([])
    expect(topics.filter((t) => !fake.joined.has(t))).toEqual([])
  })

  await test.step('the socket drops while the refresh still fails: every topic joins again', async () => {
    const sockets = fake.socketCount
    fake.dropSocket()
    await expect.poll(() => fake.socketCount, { timeout: 30_000 }).toBeGreaterThan(sockets)
    await expect.poll(() => topics.filter((t) => !fake.joined.has(t)), { timeout: 30_000 }).toEqual([])
    expect(fake.rejectedSince(failedAt)).toEqual([])
  })

  await test.step('the refresh succeeds: the new token reaches the topics, the structure topic delivers', async () => {
    const before = fake.tokens.length
    const firstToken = fake.tokens.find((f) => f.kind === 'join' && f.topic === structure)!.token
    await page.unroute(refreshRoute)
    await expect.poll(
      () => fake.tokens.slice(before).some((f) => f.topic === structure && subOf(f.token) === member.id && f.token !== firstToken),
      { timeout: 75_000 },
    ).toBe(true)
    expect(fake.rejectedSince(failedAt)).toEqual([])

    const liveName = `live-${member.username.slice(-6)}`
    const id = await addChannel(admin, server, liveName)
    const { data: row } = await admin.from('channels').select('*').eq('id', id).single()
    fake.broadcast(structure, 'server_event', { type: 'channel:insert', new: row })
    await expect(channelRow(page, liveName)).toBeVisible({ timeout: 5_000 })
  })
})

test('topics refused on the anon key join again on the next member token', async ({ page }) => {
  test.setTimeout(180_000)
  const fake = await TokenCheckingRealtime.attach(page)
  const messages = `realtime:channel-messages-${server.generalChannelId}`
  const user = `realtime:user:${member.id}`

  await test.step('open a server channel: its message and user topics join', async () => {
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await expect.poll(() => [messages, user].filter((t) => !fake.joined.has(t)), { timeout: 30_000 }).toEqual([])
  })

  const anonAt = Date.now()
  await test.step('Realtime is handed the anon key: both topics close and their rejoin is refused', async () => {
    // What supabase-js 2.84 `_getAccessToken` answers while a refresh fails on the network. The
    // token callback answers it too until the refresh below, or a heartbeat (25 s) would hand
    // Realtime the member token before the rejoin.
    await page.evaluate(async () => {
      const { supabase } = await import('/src/supabase.ts')
      const realtime = supabase.realtime as any
      const anon = (supabase as any).supabaseKey
      ;(window as any).__realtimeTokenCallback = realtime.accessToken
      realtime.accessToken = async () => anon
      await realtime.setAuth(anon)
    })
    await expect.poll(() => [messages, user].filter((t) => fake.joined.has(t)), { timeout: 15_000 }).toEqual([])
    await expect.poll(() => fake.rejectedSince(anonAt).filter((r) => r.startsWith('join')).length, { timeout: 15_000 }).toBeGreaterThan(0)
  })

  await test.step('the next refresh hands out a member token: both topics join on it', async () => {
    await page.evaluate(async () => {
      const { supabase } = await import('/src/supabase.ts')
      ;(supabase.realtime as any).accessToken = (window as any).__realtimeTokenCallback
      const { error } = await supabase.auth.refreshSession()
      if (error) throw error
    })
    await expect.poll(() => [messages, user].filter((t) => !fake.joined.has(t)), { timeout: 15_000 }).toEqual([])
    const joins = fake.tokens.filter((f) => f.kind === 'join' && f.at >= anonAt && f.topic === messages)
    expect(subOf(joins[joins.length - 1].token)).toBe(member.id)
  })

  await test.step('a message sent after it reaches the open channel', async () => {
    const text = `after-anon-${member.username.slice(-6)}`
    const { data: row, error } = await admin
      .from('messages')
      .insert({ channel_id: server.generalChannelId, user_id: member.id, content: [{ type: 'text', text }] })
      .select('*')
      .single()
    if (error) throw error
    fake.broadcast(messages, 'message_event', { op: 'INSERT', new: row })
    await expect(page.locator('[data-testid="message-list"]').getByText(text)).toBeVisible({ timeout: 10_000 })
  })
})

test('another tab signs out while its logout request fails: this tab signs out too', async ({ context }) => {
  test.setTimeout(180_000)
  const owner = await createUser(admin, 'rtothertab')
  try {
    const own = await seedServer(admin, owner, `Other tab ${owner.username}`)
    const nextName = `next-${owner.username.slice(-6)}`
    await addChannel(admin, own, nextName)
    const page = await context.newPage()
    const fake = await TokenCheckingRealtime.attach(page)
    // Torn down by the app on SIGNED_OUT. server-structure leaves only through logout().
    const ownTopics = [`realtime:user:${owner.id}`, `realtime:dm-calls:${owner.id}`]

    await test.step('this tab views a server channel', async () => {
      await signIn(page, owner)
      await openChannel(page, own.id, own.generalChannelId)
      await expect(channelRow(page, nextName)).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.user-profile')).toBeVisible()
      await expect.poll(() => ownTopics.filter((t) => !fake.joined.has(t)), { timeout: 30_000 }).toEqual([])
    })

    const other = await context.newPage()
    await test.step('the other tab signs out; its logout request fails on the network', async () => {
      await other.goto(`/chat/${own.id}/${own.generalChannelId}`)
      await other.route('**/auth/v1/logout*', (route) => route.abort('internetdisconnected'))
      await other.goto('/logout')
      await other.locator('[data-testid="logout-confirm-btn"]').click()
      await expect(other).toHaveURL(/login|\/$/, { timeout: 30_000 })
      const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => /^sb-.*-auth-token$/.test(k)))
      expect(stored).toEqual([])
    })

    const signedOutAt = Date.now()
    await test.step('this tab leaves the account: its sidebar and user panel go', async () => {
      await expect(page.locator('.user-profile')).toBeHidden({ timeout: 15_000 })
      await expect(channelRow(page, nextName)).toBeHidden()
    })

    await test.step('this tab: a socket drop rejoins none of its topics on the anon key', async () => {
      // With every channel removed realtime-js closes the socket itself and opens none.
      fake.dropSocket()
      await page.waitForTimeout(20_000)
      const anonJoins = fake.tokens
        .filter((f) => f.kind === 'join' && f.at >= signedOutAt && !subOf(f.token))
        .map((f) => f.topic)
        .filter((t) => ownTopics.includes(t) || t.startsWith('realtime:channel-messages'))
      expect(anonJoins).toEqual([])
    })
  } finally {
    await deleteUser(admin, owner)
  }
})
