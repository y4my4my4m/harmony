// Journey: peer-to-peer calls, on an instance without LiveKit.
//
// Signals go through send_signal (20261124100001), which writes them to realtime.messages with
// the caller's profile as the sender; peers connect with the ICE servers an admin set
// (20261124100002). A member who comes back without leaving gets one connection, not two. A DM
// call whose join fails cancels its ring; a ring answered on one of the account's devices stops
// on the others, the answer named by the database; a call past the account's ring limit rings no
// one and says when the next one can. A join whose signalling topic never answers fails with the
// microphone released. A file downloaded during a call leaves the call up, and signing out leaves
// it at once. A session that ends elsewhere (signed out in another tab, revoked) ends the call here
// with the microphone off and nothing sent. A callee with call notifications off declines.
//
// The stack runs no Realtime: a scripted server answers joins and heartbeats, delivers every row
// the database writes to realtime.messages to the sockets that joined its topic, and relays a
// client's own broadcast to the other sockets of a topic that takes client broadcasts (user:,
// typing:), as Realtime does with broadcast.self off; elsewhere it drops it, as the send policy
// has Realtime do. Presence gets no state. /api/livekit/config answers that LiveKit is off.

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect, type Browser, type Page, type WebSocketRoute } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { writeSpeechWav } from './livekit'

const speech = writeSpeechWav()
const run = promisify(execFile)

test.describe.configure({ mode: 'serial' })
test.use({
  serviceWorkers: 'block',
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${speech}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
})

const admin = adminClient()
const ICE_KEYS = ['voice_stun_urls', 'voice_turn_urls', 'voice_turn_auth', 'voice_turn_username', 'voice_turn_secret']
// Closed ports on this host: valid URLs that answer nothing, so host candidates carry the call.
const STUN = 'stun:127.0.0.1:9'
const TURN = 'turn:127.0.0.1:9?transport=udp'
const TURN_SECRET = 'p2p-journey-secret'

let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let lounge = ''
let conversation = ''
let iceSnapshot: Array<{ config_key: string; config_value: unknown }> = []

const dbContainer = (() => {
  let cid = ''
  return () => {
    if (cid) return cid
    const project = process.env.E2E_PROJECT || 'hme2e'
    cid = execFileSync('docker', ['ps', '-q',
      '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=db']).toString().trim()
    if (!cid) throw new Error(`no db container for project ${project}`)
    return cid
  }
})()

async function sql(query: string): Promise<string> {
  const { stdout } = await run('docker', ['exec', '-i', dbContainer(), 'psql', '-U', 'supabase_admin', '-h', '127.0.0.1',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', query], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

/** Phoenix frames: vsn 1.0.0 objects, vsn 2.0.0 arrays [join_ref, ref, topic, event, payload]. */
interface Frame {
  topic: string
  event: string
  payload: any
  ref: string | null
  join_ref: string | null
}

interface Socket {
  ws: WebSocketRoute
  array: boolean
  open: boolean
  joined: Map<string, string>
}

class ScriptedRealtime {
  private sockets: Socket[] = []
  private delivered = new Set<string>()
  private since = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  /** Broadcasts clients sent themselves, by topic. */
  readonly clientBroadcasts: Array<{ topic: string; event: string }> = []
  /** Joins of topics this matches are never answered. */
  unanswered: RegExp | null = null
  /** Joins left unanswered, by topic. */
  readonly ignoredJoins: string[] = []

  async start(): Promise<void> {
    this.since = await sql('SELECT now()::timestamp::text')
    this.timer = setInterval(() => void this.poll(), 150)
  }

  /** Open sockets that joined `topic` (without the realtime: prefix). */
  joinedBy(topic: string): number {
    return this.sockets.filter((s) => s.open && s.joined.has(`realtime:${topic}`)).length
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async attach(page: Page): Promise<void> {
    await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => this.accept(ws))
  }

  private accept(ws: WebSocketRoute): void {
    const socket: Socket = { ws, array: false, open: true, joined: new Map() }
    this.sockets.push(socket)
    ws.onClose(() => { socket.open = false })
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return
      const parsed = JSON.parse(raw)
      socket.array = Array.isArray(parsed)
      const frame: Frame = socket.array
        ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] }
        : parsed
      const reply = () => this.send(socket, { topic: frame.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: frame.ref, join_ref: frame.join_ref })
      if (frame.event === 'phx_join' && this.unanswered?.test(frame.topic)) {
        this.ignoredJoins.push(frame.topic)
      } else if (frame.event === 'phx_join') {
        socket.joined.set(frame.topic, String(frame.ref))
        reply()
      } else if (frame.event === 'phx_leave') {
        socket.joined.delete(frame.topic)
        reply()
      } else if (frame.event === 'broadcast') {
        this.clientBroadcasts.push({ topic: frame.topic, event: frame.payload?.event })
        if (!/^realtime:(user|typing):/.test(frame.topic)) {
          if (frame.ref) reply()
          return
        }
        for (const other of this.sockets) {
          const joinRef = other.joined.get(frame.topic)
          if (other === socket || !other.open || !joinRef) continue
          this.send(other, { topic: frame.topic, event: 'broadcast', payload: frame.payload, ref: null, join_ref: joinRef })
        }
        if (frame.ref) reply()
      } else if (frame.ref) {
        reply()
      }
    })
  }

  private send(socket: Socket, frame: Frame): void {
    if (!socket.open) return
    socket.ws.send(JSON.stringify(socket.array ? [frame.join_ref, frame.ref, frame.topic, frame.event, frame.payload] : frame))
  }

  /** Delivers the rows the database wrote since start() to the sockets that joined their topic. */
  private async poll(): Promise<void> {
    if (this.polling || !this.since) return
    this.polling = true
    try {
      const out = await sql(`SELECT json_build_object('id', id, 'topic', topic, 'event', event, 'payload', payload)::text
                               FROM realtime.messages WHERE inserted_at >= '${this.since}' ORDER BY inserted_at, id`)
      for (const line of out.split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as { id: string; topic: string; event: string; payload: unknown }
        if (this.delivered.has(row.id)) continue
        this.delivered.add(row.id)
        const topic = `realtime:${row.topic}`
        for (const socket of this.sockets) {
          const joinRef = socket.joined.get(topic)
          if (!socket.open || !joinRef) continue
          this.send(socket, { topic, event: 'broadcast', payload: { type: 'broadcast', event: row.event, payload: row.payload }, ref: null, join_ref: joinRef })
        }
      }
    } catch {
      // A failed read is retried on the next tick.
    } finally {
      this.polling = false
    }
  }
}

/** Every RTCPeerConnection the page makes, with its configuration. */
const recordPeerConnections = () => {
  const Native = window.RTCPeerConnection
  const made: Array<{ pc: RTCPeerConnection; config: RTCConfiguration }> = []
  ;(window as any).__peerConnections = made
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config)
      made.push({ pc: this, config: JSON.parse(JSON.stringify(config ?? {})) })
    }
  } as typeof RTCPeerConnection
}

const peerConnections = (page: Page) => page.evaluate(() => ((window as any).__peerConnections as Array<{ pc: RTCPeerConnection; config: RTCConfiguration }>)
  .map(({ pc, config }) => ({ connection: pc.connectionState, signaling: pc.signalingState, iceServers: config.iceServers ?? [] })))

/** Every microphone capture the page opens. */
const recordCaptures = () => {
  const tracks: MediaStreamTrack[] = []
  ;(window as any).__captures = tracks
  const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await native(constraints)
    tracks.push(...stream.getTracks())
    return stream
  }
}

const captures = (page: Page) => page.evaluate(() => ((window as any).__captures as MediaStreamTrack[]).map((t) => t.readyState))

/** `clock`: the page's timers are Playwright's, running at real speed until the test moves them. */
async function openAs(
  browser: Browser,
  realtime: ScriptedRealtime,
  user: SpecUser,
  { livekitConfig = true, clock = false }: { livekitConfig?: boolean; clock?: boolean } = {},
): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  if (clock) await page.clock.install()
  await page.addInitScript(recordPeerConnections)
  await page.addInitScript(recordCaptures)
  await realtime.attach(page)
  await page.route('**/api/livekit/config*', (route) => (livekitConfig
    ? route.fulfill({ json: { enabled: false, mode: 'hybrid', wsUrl: null, allowFederatedVoice: true } })
    : route.fulfill({ status: 503, json: { error: 'unavailable' } })))
  await signIn(page, user)
  return page
}

async function joinVoice(page: Page, channelId: string): Promise<void> {
  const dock = page.locator('[data-testid="dock-mute"]')
  await expect(async () => {
    if (!(await dock.isVisible())) await page.locator(`[data-nav-kind="channel"][data-nav-id="${channelId}"]`).click()
    await expect(dock).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 45_000 })
}

const row = (page: Page, user: SpecUser) => page.locator(`[data-testid="voice-participant-${user.id}"]`)
const speakingAvatar = (page: Page, user: SpecUser) => row(page, user).locator('.speaking')
const toast = (page: Page, text: string | RegExp) => page.locator('.Vue-Toastification__toast').filter({ hasText: text })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const { data, error } = await admin.from('instance_config').select('config_key, config_value').in('config_key', ICE_KEYS)
  if (error || !data || data.length !== ICE_KEYS.length) throw new Error(`ICE settings missing: ${error?.message ?? data?.length}`)
  iceSnapshot = data
  alice = await createUser(admin, 'p2pa')
  bob = await createUser(admin, 'p2pb')
  const promoted = await admin.from('profiles').update({ is_admin: true }).eq('id', alice.id)
  if (promoted.error) throw new Error(promoted.error.message)
  server = await seedServer(admin, alice, `P2P ${alice.username}`)
  await addMember(admin, bob, server.id)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const voice = await admin.from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id').single()
  if (voice.error || !voice.data) throw new Error(`lounge: ${voice.error?.message}`)
  lounge = voice.data.id
  const dm = await admin.from('conversations').insert({ type: 'direct', created_by: alice.id }).select('id').single()
  if (dm.error || !dm.data) throw new Error(`conversation: ${dm.error?.message}`)
  conversation = dm.data.id
  const parts = await admin.from('conversation_participants').insert([
    { conversation_id: conversation, user_id: alice.id },
    { conversation_id: conversation, user_id: bob.id },
  ])
  if (parts.error) throw new Error(`participants: ${parts.error.message}`)
})

test.afterAll(async () => {
  if (iceSnapshot.length) await admin.from('instance_config').upsert(iceSnapshot, { onConflict: 'config_key' })
  if (conversation) await admin.from('conversations').delete().eq('id', conversation)
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, alice)
  await deleteUser(admin, bob)
})

test('an admin sets the ICE servers; a P2P call connects with them, signals carry their real sender, and a member back without leaving has one connection', async ({ browser }) => {
  test.setTimeout(240_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  try {
    const a = await openAs(browser, realtime, alice)

    await test.step('Admin › Config › Voice & video stores the STUN and TURN servers', async () => {
      await a.goto('/admin?tab=config')
      await a.locator('.config-tab-btn', { hasText: 'Voice & video' }).click()
      const card = a.getByTestId('voice-ice-settings')
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(a.getByTestId('voice-ice-stun-default')).toBeChecked()
      await a.getByTestId('voice-ice-stun-default').uncheck()
      await a.getByTestId('voice-ice-stun-urls').fill(STUN)
      await a.getByTestId('voice-ice-turn-urls').fill(TURN)
      await a.getByTestId('voice-ice-secret').fill(TURN_SECRET)
      await a.getByTestId('voice-ice-save').click()
      await expect(toast(a, 'ICE servers saved')).toBeVisible({ timeout: 20_000 })
      const { data } = await admin.from('instance_config').select('config_key, config_value').in('config_key', ICE_KEYS)
      const stored = Object.fromEntries((data ?? []).map((r) => [r.config_key, r.config_value]))
      expect(stored).toMatchObject({ voice_stun_urls: [STUN], voice_turn_urls: [TURN], voice_turn_auth: 'secret', voice_turn_secret: TURN_SECRET })
    })

    const b = await openAs(browser, realtime, bob)
    for (const page of [a, b]) await openChannel(page, server.id, server.generalChannelId)

    await test.step('both join the lounge over P2P and hear each other', async () => {
      // Alice is muted before Bob arrives: both browsers capture the same fake speech, which echo
      // cancellation takes out of a microphone while its page plays it.
      await joinVoice(a, lounge)
      await a.locator('[data-testid="dock-mute"]').click()
      await expect(a.locator('[data-testid="dock-mute"]')).toHaveAttribute('aria-pressed', 'true')
      await joinVoice(b, lounge)
      await expect(row(a, bob)).toBeVisible({ timeout: 30_000 })
      await expect(row(b, alice)).toBeVisible({ timeout: 30_000 })
      for (const page of [a, b]) {
        await expect.poll(async () => (await peerConnections(page)).map((p) => p.connection), { timeout: 30_000 }).toContain('connected')
      }
      // Speaking is read from the received track: no peer sends levels.
      await expect(speakingAvatar(a, bob)).toBeVisible({ timeout: 10_000 })
      await expect(speakingAvatar(b, alice)).toHaveCount(0, { timeout: 6_000 })
    })

    await test.step('peer connections use the instance\'s servers, with per-account TURN credentials', async () => {
      for (const [page, user] of [[a, alice], [b, bob]] as const) {
        const [pc] = await peerConnections(page)
        expect(pc.iceServers).toEqual([
          { urls: [STUN] },
          { urls: [TURN], username: expect.stringMatching(new RegExp(`^\\d+:${user.id}$`)), credential: expect.any(String) },
        ])
      }
    })

    await test.step('every signal was relayed by the database under its caller; no client broadcast on the room', async () => {
      const senders = (await sql(`SELECT DISTINCT payload->>'from' FROM realtime.messages
                                   WHERE topic = 'harmony-voice-${lounge}' AND event = 'signals'`)).split('\n').sort()
      expect(senders).toEqual([alice.id, bob.id].sort())
      expect(realtime.clientBroadcasts.filter((m) => m.topic === `realtime:harmony-voice-${lounge}`)).toEqual([])
    })

    await test.step('Bob\'s tab dies without leaving; back in the lounge, Alice holds one live connection to him', async () => {
      await b.close({ runBeforeUnload: false })
      const b2 = await openAs(browser, realtime, bob)
      await openChannel(b2, server.id, server.generalChannelId)
      await joinVoice(b2, lounge)
      await expect.poll(async () => (await peerConnections(b2)).map((p) => p.connection), { timeout: 30_000 }).toContain('connected')
      await expect.poll(async () => {
        const pcs = await peerConnections(a)
        return { count: pcs.length, first: pcs[0]?.signaling, open: pcs.filter((p) => p.signaling !== 'closed').length, last: pcs.at(-1)?.connection }
      }, { timeout: 30_000 }).toEqual({ count: 2, first: 'closed', open: 1, last: 'connected' })
      await expect(row(a, bob)).toHaveCount(1)
      await expect(speakingAvatar(a, bob)).toBeVisible({ timeout: 10_000 })
      await b2.context().close()
    })
    await a.context().close()
  } finally {
    realtime.stop()
  }
})

test('a DM call whose join fails stops ringing at once, and no "No answer" follows', async ({ browser }) => {
  test.setTimeout(120_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  try {
    const b = await openAs(browser, realtime, bob)
    await b.goto('/dm')
    await expect.poll(() => realtime.joinedBy(`dm-calls:${bob.id}`), { timeout: 30_000 }).toBe(1)

    // The voice server settings cannot be read: the caller's join fails after the ring went out.
    const a = await openAs(browser, realtime, alice, { livekitConfig: false, clock: true })
    await a.goto(`/dm/${conversation}`)
    await a.locator('[data-testid="dm-call"]').click()
    await expect(toast(a, /voice server settings could not be loaded|Failed to start call/)).toBeVisible({ timeout: 20_000 })

    await expect.poll(() => sql(`SELECT string_agg(payload->>'type', ',' ORDER BY inserted_at) FROM realtime.messages
                                  WHERE topic = 'dm-calls:${bob.id}' AND inserted_at >= now() - interval '2 minutes'`), { timeout: 15_000 })
      .toBe('initiate,end')
    await expect(b.getByTestId('incoming-call-modal')).toHaveCount(0, { timeout: 5_000 })

    // Past the caller's 30 s ring timeout: the toast of a ring left running would be up.
    await a.clock.runFor(32_000)
    await a.waitForTimeout(500)
    await expect(toast(a, 'No answer')).toHaveCount(0)
    await expect(toast(b, 'Missed call')).toHaveCount(0)
    await a.context().close()
    await b.context().close()
  } finally {
    realtime.stop()
  }
})

test('a P2P join whose topic never answers fails with the microphone released, and answers no one who joins later', async ({ browser }) => {
  test.setTimeout(150_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  try {
    const b = await openAs(browser, realtime, bob, { clock: true })
    await openChannel(b, server.id, server.generalChannelId)
    realtime.unanswered = new RegExp(`harmony-voice-${lounge}$`)

    await test.step('Bob\'s join waits 15 s for its topic, then gives up', async () => {
      await b.locator(`[data-nav-kind="channel"][data-nav-id="${lounge}"]`).click()
      await expect.poll(() => realtime.ignoredJoins.length, { timeout: 30_000 }).toBeGreaterThan(0)
      await expect.poll(() => captures(b), { timeout: 10_000 }).toContain('live')
      await b.clock.runFor(16_000)
      await expect(b.locator('[data-testid="dock-mute"]')).toHaveCount(0, { timeout: 15_000 })
      await expect.poll(() => captures(b), { timeout: 10_000 }).toEqual(['ended'])
    })

    await test.step('Alice joins after it: Bob, whose topic answers now, sends her nothing', async () => {
      realtime.unanswered = null
      const since = await sql('SELECT now()::timestamp::text')
      const a = await openAs(browser, realtime, alice)
      await openChannel(a, server.id, server.generalChannelId)
      await joinVoice(a, lounge)
      await b.clock.runFor(15_000)
      await a.waitForTimeout(3_000)
      expect(await sql(`SELECT count(*) FROM realtime.messages WHERE topic = 'harmony-voice-${lounge}'
                           AND payload->>'from' = '${bob.id}' AND inserted_at >= '${since}'`)).toBe('0')
      expect(await peerConnections(b)).toEqual([])
      expect(await peerConnections(a)).toEqual([])
      await a.context().close()
    })
    await b.context().close()
  } finally {
    realtime.stop()
  }
})

test('a file downloaded during a P2P call leaves the call up, and signing out leaves the call at once', async ({ browser }) => {
  test.setTimeout(180_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  try {
    const a = await openAs(browser, realtime, alice)
    const b = await openAs(browser, realtime, bob)
    for (const page of [a, b]) {
      await openChannel(page, server.id, server.generalChannelId)
      await dismissAnnouncements(page)
      await joinVoice(page, lounge)
    }
    for (const page of [a, b]) {
      await expect.poll(async () => (await peerConnections(page)).map((p) => p.connection), { timeout: 30_000 }).toContain('connected')
    }

    /** user-left signals of Bob's the database relayed to the lounge since `since`. */
    const bobLeft = (since: string) => sql(`SELECT count(*) FROM realtime.messages m, jsonb_array_elements(m.payload->'messages') signal
                                             WHERE m.topic = 'harmony-voice-${lounge}' AND m.payload->>'from' = '${bob.id}'
                                               AND signal->>'type' = 'user-left' AND m.inserted_at >= '${since}'`)

    await test.step('Bob downloads a file posted in the channel; the call stays connected', async () => {
      const since = await sql('SELECT now()::timestamp::text')
      await b.getByTestId('composer-file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('call notes') })
      await expect(b.getByTestId('file-preview-item').filter({ hasText: 'notes.txt' })).toContainText('Uploaded', { timeout: 20_000 })
      await sendMessage(b, 'the notes')
      const sent = messageList(b).locator('.message-item').filter({ hasText: 'the notes' })
      await expect(sent.getByTestId('file-attachment-link')).toBeVisible({ timeout: 20_000 })
      // Chromium fires beforeunload for the storage link before it turns into a download.
      await b.evaluate(() => {
        ;(window as any).__beforeunloads = 0
        window.addEventListener('beforeunload', () => { (window as any).__beforeunloads++ })
      })
      const download = b.waitForEvent('download')
      await sent.getByTestId('file-attachment-link').click()
      expect((await download).suggestedFilename()).toBe('notes.txt')
      expect(await b.evaluate(() => (window as any).__beforeunloads)).toBeGreaterThan(0)

      await b.waitForTimeout(3_000)
      await expect(b.locator('[data-testid="dock-mute"]')).toBeVisible()
      for (const page of [a, b]) {
        expect((await peerConnections(page)).map((p) => p.connection)).toEqual(['connected'])
      }
      expect(await captures(b)).toEqual(['live'])
      expect(await bobLeft(since)).toBe('0')
      await expect(row(a, bob)).toBeVisible()
    })

    await test.step('Bob signs out: Alice\'s connection to him closes on his user-left, not on a timeout', async () => {
      const since = await sql('SELECT now()::timestamp::text')
      await b.getByRole('region', { name: 'Your account' }).getByRole('button', { name: 'Settings' }).click()
      await b.getByRole('button', { name: 'Log out' }).click()
      await expect(b).toHaveURL(/\/login/, { timeout: 30_000 })
      expect(await bobLeft(since)).toBe('1')
      expect(await captures(b)).toEqual(['ended'])
      await expect.poll(async () => (await peerConnections(a)).filter((p) => p.signaling !== 'closed').length, { timeout: 5_000 }).toBe(0)
    })
    await a.context().close()
    await b.context().close()
  } finally {
    realtime.stop()
  }
})

test('a session that ends elsewhere ends the call in this tab: microphone off, sign-in shown, nothing sent', async ({ browser }) => {
  test.setTimeout(180_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  // An account of its own: its sessions are ended.
  const carol = await createUser(admin, 'p2pd')
  try {
    await addMember(admin, carol, server.id)
    const a = await openAs(browser, realtime, alice)
    const c = await openAs(browser, realtime, carol)
    await openChannel(a, server.id, server.generalChannelId)
    await joinVoice(a, lounge)

    /** What Carol's call would send: signals, rings, her row in the channel. */
    const sent: string[] = []
    c.on('request', (request) => {
      if (/\/rpc\/(send_signal|ring_dm_call|touch_voice_participant)|\/voice_channel_participants\?/.test(request.url()) && request.method() !== 'GET') sent.push(request.url())
    })

    const enterCall = async () => {
      await openChannel(c, server.id, server.generalChannelId)
      await dismissAnnouncements(c)
      await joinVoice(c, lounge)
      await expect.poll(async () => (await peerConnections(c)).map((p) => p.connection), { timeout: 30_000 }).toContain('connected')
      await expect.poll(() => captures(c), { timeout: 10_000 }).toEqual(['live'])
      await expect.poll(async () => (await peerConnections(a)).filter((p) => p.connection === 'connected').length, { timeout: 30_000 }).toBe(1)
      // Signals of the join are out.
      await c.waitForTimeout(1_000)
      await c.evaluate(() => { (window as unknown as { __samePage?: boolean }).__samePage = true })
      sent.length = 0
    }

    /** Carol's page is out of the call, on sign-in, without a reload; Alice's connection to her ends. */
    const expectOut = async (url: RegExp) => {
      await expect.poll(() => captures(c), { timeout: 10_000 }).toEqual(['ended'])
      await expect(c).toHaveURL(url, { timeout: 20_000 })
      expect(await c.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage)).toBe(true)
      expect((await peerConnections(c)).filter((p) => p.signaling !== 'closed')).toEqual([])
      await expect(c.locator('[data-testid="dock-mute"]')).toHaveCount(0)
      await expect(c.getByTestId('voice-overlay')).toHaveCount(0)
      await expect(c.locator('[data-testid="auth-email"]')).toBeVisible()
      await c.waitForTimeout(1_500)
      expect(sent).toEqual([])
      await expect.poll(async () => (await peerConnections(a)).filter((p) => p.connection === 'connected').length, { timeout: 30_000 }).toBe(0)
    }

    await test.step('signed out in another tab', async () => {
      await enterCall()
      const tab = await c.context().newPage()
      await realtime.attach(tab)
      await tab.goto('/settings/account')
      await dismissAnnouncements(tab)
      await tab.getByRole('button', { name: 'Log out' }).click()
      await expect(tab).toHaveURL(/\/login/, { timeout: 30_000 })
      await expectOut(/\/login$/)
      await tab.close()
    })

    await test.step('revoked: the next refused request ends it, with the reason', async () => {
      await signIn(c, carol)
      await enterCall()
      await sql(`DELETE FROM auth.sessions WHERE user_id = '${carol.id}'`)
      await c.locator('[data-testid="message-input"] .rich-text-editor').click()
      await c.keyboard.type('anyone here?')
      await c.keyboard.press('Enter')
      await expectOut(/\/login\?reason=session_revoked$/)
    })
    for (const page of [a, c]) await page.context().close()
  } finally {
    realtime.stop()
    await deleteUser(admin, carol)
  }
})

test('a callee with call notifications off declines at once, and a join that fails after the caller moved to another DM cancels its own ring', async ({ browser }) => {
  test.setTimeout(150_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  const other = await admin.from('conversations').insert({ type: 'direct', created_by: alice.id }).select('id').single()
  if (other.error) throw new Error(other.error.message)
  try {
    const third = await createUser(admin, 'p2pc')
    try {
      await admin.from('conversation_participants').insert([
        { conversation_id: other.data.id, user_id: alice.id }, { conversation_id: other.data.id, user_id: third.id },
      ])
      const b = await openAs(browser, realtime, bob)
      await b.goto('/dm')
      await expect.poll(() => realtime.joinedBy(`dm-calls:${bob.id}`), { timeout: 30_000 }).toBe(1)
      const a = await openAs(browser, realtime, alice)
      await a.goto(`/dm/${conversation}`)

      await test.step('call notifications off: the caller hears the decline, not 30 s of ringing', async () => {
        const off = await admin.from('notification_preferences')
          .update({ sound_voice_activity: false, desktop_notifications: false }).eq('user_id', bob.id)
        if (off.error) throw new Error(off.error.message)
        await a.locator('[data-testid="dm-call"]').click()
        await expect(toast(a, 'Call declined')).toBeVisible({ timeout: 15_000 })
        await expect(b.getByTestId('incoming-call-modal')).toHaveCount(0)
        await a.getByTestId('voice-leave').click()
        await admin.from('notification_preferences')
          .update({ sound_voice_activity: true, desktop_notifications: true }).eq('user_id', bob.id)
      })

      await test.step('a join that fails with another DM open ends the ring it belongs to', async () => {
        // The voice server settings answer 503 once the caller has moved on.
        let fail!: () => void
        const moved = new Promise<void>((resolve) => { fail = resolve })
        await a.unroute('**/api/livekit/config*')
        await a.route('**/api/livekit/config*', async (route) => {
          await moved
          await route.fulfill({ status: 503, json: { error: 'unavailable' } })
        })
        // A reload forgets the settings the first call fetched.
        await a.goto(`/dm/${conversation}`)
        const since = await sql('SELECT now()::timestamp::text')
        await a.locator('[data-testid="dm-call"]').click()
        await expect(b.getByTestId('incoming-call-modal')).toBeVisible({ timeout: 20_000 })
        await a.locator(`a[href="/dm/${other.data.id}"]`).first().click()
        await expect(a.getByRole('heading', { name: third.displayName })).toBeVisible({ timeout: 15_000 })
        fail()
        await expect(b.getByTestId('incoming-call-modal')).toHaveCount(0, { timeout: 15_000 })
        await expect.poll(() => sql(`SELECT string_agg(payload->>'type', ',' ORDER BY inserted_at) FROM realtime.messages
                                      WHERE topic = 'dm-calls:${bob.id}' AND event = 'incoming-call' AND inserted_at >= '${since}'`))
          .toBe('initiate,end')
      })
      for (const page of [a, b]) await page.context().close()
    } finally {
      await deleteUser(admin, third)
    }
  } finally {
    realtime.stop()
    await admin.from('conversations').delete().eq('id', other.data.id)
  }
})

test('a ring answered on one of Bob\'s devices stops on the other', async ({ browser }) => {
  test.setTimeout(120_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  const since = await sql('SELECT now()::timestamp::text')
  try {
    const phone = await openAs(browser, realtime, bob)
    const laptop = await openAs(browser, realtime, bob)
    for (const page of [phone, laptop]) {
      await page.goto('/dm')
    }
    await expect.poll(() => realtime.joinedBy(`dm-calls:${bob.id}`), { timeout: 30_000 }).toBe(2)

    const a = await openAs(browser, realtime, alice)
    await a.goto(`/dm/${conversation}`)
    await a.locator('[data-testid="dm-call"]').click()

    await expect(phone.getByTestId('incoming-call-modal')).toBeVisible({ timeout: 20_000 })
    await expect(laptop.getByTestId('incoming-call-modal')).toBeVisible({ timeout: 20_000 })

    await phone.getByTestId('incoming-call-accept').click()
    await expect(phone.getByTestId('incoming-call-modal')).toHaveCount(0)
    await expect(laptop.getByTestId('incoming-call-modal')).toHaveCount(0, { timeout: 10_000 })
    await expect(laptop.getByTestId('incoming-call-mini')).toHaveCount(0)

    await expect.poll(async () => (await peerConnections(phone)).map((p) => p.connection), { timeout: 30_000 }).toContain('connected')
    await expect(toast(laptop, 'Missed call')).toHaveCount(0)

    // The answer reached the laptop and the caller as the database relayed it, naming Bob.
    expect(await sql(`SELECT string_agg(payload->>'type' || ' ' || (payload->>'callerId'), ',' ORDER BY inserted_at)
                        FROM realtime.messages WHERE topic = 'dm-call:${conversation}' AND event = 'call-signal'
                         AND inserted_at >= '${since}'`)).toMatch(new RegExp(`^accept ${bob.id}(,join ${bob.id})?$`))
    expect(realtime.clientBroadcasts.filter((m) => /^realtime:(dm-call|harmony-voice|easter-egg)/.test(m.topic))).toEqual([])
    // The laptop heard it on Bob's own ring topic, which only the database writes.
    expect(await sql(`SELECT string_agg(payload->>'type' || ' ' || (payload->>'callerId'), ',' ORDER BY inserted_at)
                        FROM realtime.messages WHERE topic = 'dm-calls:${bob.id}' AND event = 'call-signal'
                         AND inserted_at >= '${since}'`)).toMatch(new RegExp(`^accept ${bob.id}(,join ${bob.id})?$`))
    for (const page of [a, phone, laptop]) await page.context().close()
  } finally {
    realtime.stop()
  }
})

test('a call past the account\'s ring limit rings no one and says when the next can', async ({ browser }) => {
  test.setTimeout(120_000)
  const realtime = new ScriptedRealtime()
  await realtime.start()
  const { data: antispam } = await admin.from('instance_config').select('config_value').eq('config_key', 'antispam').maybeSingle()
  const stored = (antispam?.config_value ?? {}) as Record<string, unknown>
  await admin.from('instance_config').upsert({ config_key: 'antispam', config_value: { ...stored, account_rings_per_minute: 1 } }, { onConflict: 'config_key' })
  try {
    // Bob calls: the earlier calls of this file were Alice's, still inside the minute.
    const callee = await openAs(browser, realtime, alice)
    await callee.goto('/dm')
    await expect.poll(() => realtime.joinedBy(`dm-calls:${alice.id}`), { timeout: 30_000 }).toBe(1)
    const caller = await openAs(browser, realtime, bob)
    await caller.goto(`/dm/${conversation}`)
    const rings = () => sql(`SELECT count(*) FROM realtime.messages WHERE topic = 'dm-calls:${alice.id}'
                                AND payload->>'type' = 'initiate' AND inserted_at > now() - interval '1 minute'`)

    await caller.locator('[data-testid="dm-call"]').click()
    await expect(callee.getByTestId('incoming-call-modal')).toBeVisible({ timeout: 20_000 })
    await expect.poll(rings, { timeout: 10_000 }).toBe('1')
    // Hang up: the call view covers the header until minimized.
    await caller.getByRole('button', { name: 'Minimize call view' }).click()
    await caller.locator('[data-testid="dm-call"]').click()
    await expect(callee.getByTestId('incoming-call-modal')).toHaveCount(0, { timeout: 15_000 })

    await caller.locator('[data-testid="dm-call"]').click()
    await expect(toast(caller, /Try again in/i)).toBeVisible({ timeout: 15_000 })
    expect(await rings()).toBe('1')
    await expect(callee.getByTestId('incoming-call-modal')).toHaveCount(0)
    for (const page of [caller, callee]) await page.context().close()
  } finally {
    realtime.stop()
    await admin.from('instance_config').upsert({ config_key: 'antispam', config_value: stored }, { onConflict: 'config_key' })
  }
})
