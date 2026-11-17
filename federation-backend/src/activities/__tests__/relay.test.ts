import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { ActivityRelay, type Admission, type RelayDeps, type RelayOptions } from '../relay.js'
import { CLOSE, MESSAGE_MAX_BYTES, type RelayFrame } from '../protocol.js'

const SESSION = '0a0a0a0a-0000-4000-8000-000000000001'
const ALICE = '11111111-0000-4000-8000-000000000001'
const BOB = '22222222-0000-4000-8000-000000000002'
const CAROL = '33333333-0000-4000-8000-000000000003'

const DAVE = '44444444-0000-4000-8000-000000000004'
const ERIN = '55555555-0000-4000-8000-000000000005'
const FRED = '66666666-0000-4000-8000-000000000006'

const NAMES: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob', [CAROL]: 'carol', [DAVE]: 'dave', [ERIN]: 'erin', [FRED]: 'fred' }

interface Fake extends RelayDeps {
  refusals: Map<string, string>
  signedOut: Set<string>
  admitError: boolean
  stall: boolean
  maxPlayers: number
  finished: Array<{ id: string; reason: string }>
  syncs: Array<{ members: string[]; host: string | null }>
  syncResult: boolean
  canEnd: Set<string>
  expiresAt: number | null
}

function fakeDeps(): Fake {
  const fake: Fake = {
    refusals: new Map(),
    signedOut: new Set(),
    admitError: false,
    stall: false,
    maxPlayers: 8,
    finished: [],
    syncs: [],
    syncResult: true,
    canEnd: new Set([ALICE]),
    expiresAt: null,
    async verifyToken(token) {
      if (fake.stall) return new Promise(() => {})
      const id = token.replace(/^token-/, '')
      return NAMES[id] && !fake.signedOut.has(id) ? { profileId: id, expiresAt: fake.expiresAt } : null
    },
    async admit(_session, profileId): Promise<Admission> {
      if (fake.admitError) throw new Error('database down')
      const refusal = fake.refusals.get(profileId)
      if (refusal) return { refusal }
      return {
        session: { id: SESSION, app_id: 'drawinphone', context: 'direct', started_by: ALICE, max_players: fake.maxPlayers, min_players: 2 },
        member: { id: profileId, username: NAMES[profileId], display_name: NAMES[profileId].toUpperCase(), avatar_url: null },
        can_end: fake.canEnd.has(profileId),
      }
    },
    async sync(_session, members, host) {
      fake.syncs.push({ members: [...members].sort(), host })
      return fake.syncResult
    },
    async finish(id, reason) {
      fake.finished.push({ id, reason })
    },
  }
  return fake
}

class Client {
  readonly frames: RelayFrame[] = []
  private waiters: Array<{ match: (f: RelayFrame) => boolean; resolve: (f: RelayFrame) => void }> = []
  closed: Promise<{ code: number; reason: string }>

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as RelayFrame
      this.frames.push(frame)
      const waiter = this.waiters.find((w) => w.match(frame))
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(frame)
      }
    })
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame))
  }

  /** The next frame with `op` (and matching `extra`), including one already received and unclaimed. */
  next<T extends RelayFrame['op']>(op: T, where: (f: Extract<RelayFrame, { op: T }>) => boolean = () => true): Promise<Extract<RelayFrame, { op: T }>> {
    const match = (f: RelayFrame) => f.op === op && where(f as Extract<RelayFrame, { op: T }>)
    const index = this.frames.findIndex(match)
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0] as Extract<RelayFrame, { op: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${op} frame`)), 2000)
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer)
          this.frames.splice(this.frames.indexOf(f), 1)
          resolve(f as Extract<RelayFrame, { op: T }>)
        },
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

let server: Server
let relay: ActivityRelay
let deps: Fake
let url: string

async function start(options: Partial<RelayOptions> = {}): Promise<void> {
  deps = fakeDeps()
  server = createServer()
  relay = new ActivityRelay(deps, {
    upgradeBurst: 100,
    hostGraceMs: 80,
    emptyGraceMs: 80,
    syncDebounceMs: 10,
    allowedOrigins: ['https://app.example'],
    ...options,
  })
  relay.attach(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/federation/activities/socket`
}

async function open(headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(url, { headers })
  const client = new Client(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return client
}

async function join(id: string): Promise<{ client: Client; welcome: Extract<RelayFrame, { op: 'welcome' }> }> {
  const client = await open()
  client.send({ op: 'hello', v: 1, token: `token-${id}`, session: SESSION })
  const welcome = await client.next('welcome')
  return { client, welcome }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  await start()
})

afterEach(async () => {
  await relay.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('activity relay: joining', () => {
  it('welcomes the first member as host and tells it about the second', async () => {
    const a = await join(ALICE)
    expect(a.welcome.host).toBe(ALICE)
    expect(a.welcome.you).toMatchObject({ id: ALICE, name: 'ALICE', username: 'alice', spectator: false })
    expect(a.welcome.store).toEqual({})
    expect(a.welcome.canEnd).toBe(true)
    expect(a.welcome.session).toMatchObject({ id: SESSION, appId: 'drawinphone', maxPlayers: 8, minPlayers: 2 })

    const b = await join(BOB)
    expect(b.welcome.host).toBe(ALICE)
    expect(b.welcome.store).toBeUndefined()
    expect(b.welcome.members.map((m) => m.id)).toEqual([ALICE, BOB])
    expect((await a.client.next('join')).member.id).toBe(BOB)

    await sleep(40)
    expect(deps.syncs.at(-1)).toEqual({ members: [ALICE, BOB].sort(), host: ALICE })
  })

  it('refuses an invalid token and closes with 4001', async () => {
    const client = await open()
    client.send({ op: 'hello', v: 1, token: 'token-nobody', session: SESSION })
    expect(await client.next('error')).toMatchObject({ code: 'UNAUTHORIZED', fatal: true })
    expect((await client.closed).code).toBe(CLOSE.UNAUTHORIZED)
  })

  it('passes the database refusal on and closes with 4003', async () => {
    deps.refusals.set(CAROL, 'NOT_FOUND')
    const client = await open()
    client.send({ op: 'hello', v: 1, token: `token-${CAROL}`, session: SESSION })
    expect(await client.next('error')).toMatchObject({ code: 'REFUSED', refusal: 'NOT_FOUND' })
    expect((await client.closed).code).toBe(CLOSE.REFUSED)
    expect(relay.sessionCount).toBe(0)
  })

  it('closes a socket that never says hello', async () => {
    await relay.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await start({ helloTimeoutMs: 50 })
    const client = await open()
    expect((await client.closed).code).toBe(CLOSE.NO_HELLO)
  })

  it('refuses an unknown protocol version', async () => {
    const client = await open()
    client.send({ op: 'hello', v: 2, token: `token-${ALICE}`, session: SESSION })
    expect(await client.next('error')).toMatchObject({ code: 'REFUSED', refusal: 'UNSUPPORTED_VERSION' })
  })

  it('refuses an origin outside the allowed list before the upgrade', async () => {
    const ws = new WebSocket(url, { headers: { Origin: 'https://evil.example' } })
    const status = await new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
    expect(status).toBe(403)
  })

  it('replaces an older connection of the same account', async () => {
    const first = await join(ALICE)
    const second = await join(ALICE)
    expect(await first.client.next('error')).toMatchObject({ code: 'REPLACED' })
    expect((await first.client.closed).code).toBe(CLOSE.REPLACED)
    expect(second.welcome.host).toBe(ALICE)
    expect(second.welcome.members.map((m) => m.id)).toEqual([ALICE])
  })

  it('admits members past max_players as spectators', async () => {
    deps.maxPlayers = 1
    await join(ALICE)
    const b = await join(BOB)
    expect(b.welcome.you.spectator).toBe(true)
  })
})

describe('activity relay: traffic', () => {
  it('broadcasts, sends to the host and to listed members', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    const c = await join(CAROL)

    b.client.send({ op: 'send', data: { hi: 1 } })
    expect(await a.client.next('message')).toEqual({ op: 'message', from: BOB, data: { hi: 1 } })
    expect(await c.client.next('message')).toEqual({ op: 'message', from: BOB, data: { hi: 1 } })

    c.client.send({ op: 'send', data: 'to host', to: 'host' })
    expect((await a.client.next('message')).data).toBe('to host')

    a.client.send({ op: 'send', data: 'only carol', to: [CAROL] })
    expect((await c.client.next('message')).data).toBe('only carol')
    await sleep(30)
    expect(b.client.frames.filter((f) => f.op === 'message')).toHaveLength(0)
  })

  it('lets only the host write the state, and hands it to joiners', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    b.client.send({ op: 'state', state: { phase: 'mine' } })
    expect(await b.client.next('error')).toMatchObject({ code: 'NOT_HOST' })

    a.client.send({ op: 'state', state: { phase: 'draw' } })
    expect(await b.client.next('state')).toEqual({ op: 'state', state: { phase: 'draw' }, from: ALICE })
    const c = await join(CAROL)
    expect(c.welcome.state).toEqual({ phase: 'draw' })
  })

  it('keeps the store private to the host and enforces its limits', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    a.client.send({ op: 'store', key: 'chain:1', value: { secret: true } })
    b.client.send({ op: 'store', key: 'chain:1', value: 'mine' })
    expect(await b.client.next('error')).toMatchObject({ code: 'NOT_HOST' })
    a.client.send({ op: 'store', key: 'big', value: 'x'.repeat(260 * 1024) })
    expect(await a.client.next('error')).toMatchObject({ code: 'TOO_LARGE' })
    await sleep(30)
    expect(b.client.frames.some((f) => JSON.stringify(f).includes('secret'))).toBe(false)
  })

  it('broadcasts member state and keeps it across a reconnect', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    b.client.send({ op: 'me', state: { ready: true } })
    expect(await a.client.next('member')).toEqual({ op: 'member', id: BOB, state: { ready: true } })
    b.client.close()
    await a.client.next('leave')
    const again = await join(BOB)
    expect(again.welcome.you.state).toEqual({ ready: true })
  })

  it('refuses a message over MESSAGE_MAX_BYTES', async () => {
    const a = await join(ALICE)
    a.client.send({ op: 'send', data: 'x'.repeat(MESSAGE_MAX_BYTES + 10) })
    expect(await a.client.next('error')).toMatchObject({ code: 'TOO_LARGE' })
  })

  it('rate-limits a burst', async () => {
    const a = await join(ALICE)
    for (let i = 0; i < 120; i++) a.client.send({ op: 'me', state: i })
    expect(await a.client.next('error', (f) => f.code === 'RATE_LIMITED')).toBeTruthy()
  })

  it('answers ping with the relay clock', async () => {
    const a = await join(ALICE)
    a.client.send({ op: 'ping', t: 42 })
    const pong = await a.client.next('pong')
    expect(pong.t).toBe(42)
    expect(Math.abs(pong.serverTime - Date.now())).toBeLessThan(1000)
  })

  it('closes on a frame that is not JSON', async () => {
    const a = await join(ALICE)
    a.client.ws.send('{nope')
    expect((await a.client.closed).code).toBe(CLOSE.BAD_FRAME)
  })
})

describe('activity relay: host and lifetime', () => {
  it('promotes the earliest member once the host stays away, handing it the store', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    const c = await join(CAROL)
    a.client.send({ op: 'store', key: 'round', value: 3 })
    await sleep(20)
    a.client.close()
    expect((await b.client.next('leave')).id).toBe(ALICE)
    const promoted = await b.client.next('host')
    expect(promoted).toEqual({ op: 'host', id: BOB, store: { round: 3 } })
    expect(await c.client.next('host')).toEqual({ op: 'host', id: BOB })
  })

  it('keeps the host when it reconnects within the grace period', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    a.client.close()
    await b.client.next('leave')
    const again = await join(ALICE)
    expect(again.welcome.host).toBe(ALICE)
    expect(again.welcome.store).toEqual({})
    await sleep(120)
    expect(b.client.frames.some((f) => f.op === 'host')).toBe(false)
  })

  it('ends an empty session after the grace period', async () => {
    const a = await join(ALICE)
    a.client.close()
    await sleep(150)
    expect(deps.finished).toEqual([{ id: SESSION, reason: 'empty' }])
    expect(relay.sessionCount).toBe(0)
  })

  it('lets the host end the session for everyone', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    b.client.send({ op: 'end' })
    expect(await b.client.next('error')).toMatchObject({ code: 'NOT_HOST' })
    a.client.send({ op: 'end' })
    expect(await b.client.next('ended')).toEqual({ op: 'ended', reason: 'host_ended' })
    expect((await b.client.closed).code).toBe(CLOSE.ENDED)
    expect(deps.finished).toEqual([{ id: SESSION, reason: 'host_ended' }])
  })

  it('lets a member with can_end end it without hosting', async () => {
    deps.canEnd = new Set([BOB])
    const a = await join(ALICE)
    const b = await join(BOB)
    b.client.send({ op: 'end' })
    expect(await a.client.next('ended')).toEqual({ op: 'ended', reason: 'host_ended' })
  })

  it('removes a member the database no longer admits', async () => {
    await relay.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await start({ readmitMs: 60 })
    const a = await join(ALICE)
    const b = await join(BOB)
    deps.refusals.set(BOB, 'NOT_FOUND')
    expect(await b.client.next('error')).toMatchObject({ code: 'REFUSED', refusal: 'NOT_FOUND' })
    expect(await a.client.next('leave')).toEqual({ op: 'leave', id: BOB, reason: 'removed' })
  })

  it('ends the session when the database says it is no longer active', async () => {
    await relay.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await start({ heartbeatMs: 50 })
    const a = await join(ALICE)
    deps.syncResult = false
    expect(await a.client.next('ended')).toEqual({ op: 'ended', reason: 'ended' })
    expect(deps.finished).toEqual([])
  })

  it('closes a connection whose token expires without a refresh', async () => {
    await relay.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await start({ tokenGraceMs: 0 })
    deps.expiresAt = Date.now() + 60
    const a = await join(ALICE)
    expect(await a.client.next('error')).toMatchObject({ code: 'UNAUTHORIZED' })
    expect((await a.client.closed).code).toBe(CLOSE.UNAUTHORIZED)
  })

  it('keeps a connection whose token is refreshed in time', async () => {
    await relay.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await start({ tokenGraceMs: 0 })
    deps.expiresAt = Date.now() + 80
    const a = await join(ALICE)
    deps.expiresAt = Date.now() + 10_000
    a.client.send({ op: 'auth', token: `token-${ALICE}` })
    await sleep(150)
    expect(a.client.ws.readyState).toBe(WebSocket.OPEN)
  })
})

describe('activity relay: limits', () => {
  it('refuses connections past the per-address cap', async () => {
    await relay.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await start({ maxConnectionsPerIp: 1 })
    await open()
    const ws = new WebSocket(url)
    const status = await new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
    expect(status).toBe(503)
  })

  it('ignores upgrades on other paths', async () => {
    const other = vi.fn()
    server.on('upgrade', (_req, socket) => {
      other()
      socket.destroy()
    })
    const ws = new WebSocket(url.replace('/api/federation/activities/socket', '/elsewhere'))
    ws.on('error', () => {})
    await sleep(50)
    expect(other).toHaveBeenCalled()
    ws.terminate()
  })
})

async function restart(options: Partial<RelayOptions>): Promise<void> {
  await relay.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await start(options)
}

describe('activity relay: hardening', () => {
  it('counts live players: a returning player spectates when the room filled meanwhile', async () => {
    deps.maxPlayers = 2
    const a = await join(ALICE)
    await join(BOB)
    const c = await join(CAROL)
    expect(c.welcome.you.spectator).toBe(true)
    a.client.close()
    await sleep(20)
    const d = await join(DAVE)
    expect(d.welcome.you.spectator).toBe(false)
    const again = await join(ALICE)
    expect(again.welcome.you.spectator).toBe(true)
  })

  it('never makes a spectator host', async () => {
    deps.maxPlayers = 1
    const a = await join(ALICE)
    const b = await join(BOB)
    expect(b.welcome.you.spectator).toBe(true)
    a.client.close()
    await b.client.next('leave')
    await sleep(150)
    expect(b.client.frames.some((f) => f.op === 'host')).toBe(false)
  })

  it('refuses a session this process ended while the database still admits it', async () => {
    const a = await join(ALICE)
    a.client.send({ op: 'end' })
    await a.client.closed
    const late = await open()
    late.send({ op: 'hello', v: 1, token: `token-${BOB}`, session: SESSION })
    expect(await late.next('error')).toMatchObject({ code: 'REFUSED', refusal: 'ENDED' })
  })

  it('ignores frames from a replaced connection', async () => {
    const first = await join(ALICE)
    const b = await join(BOB)
    await join(ALICE)
    await first.client.next('error')
    first.client.send({ op: 'send', data: 'stale' })
    await sleep(40)
    expect(b.client.frames.some((f) => f.op === 'message')).toBe(false)
  })

  it('charges a broadcast to its sender once per recipient', async () => {
    const members = [ALICE, BOB, CAROL, DAVE, ERIN, FRED]
    const joined = []
    for (const id of members) joined.push(await join(id))
    const big = 'x'.repeat(240 * 1024)
    // 240 KB to 5 members costs about 1.2 MB of the 4 MB burst: the fourth is refused.
    for (let i = 0; i < 4; i++) joined[0].client.send({ op: 'send', data: big })
    expect(await joined[0].client.next('error', (f) => f.code === 'RATE_LIMITED')).toBeTruthy()
    await sleep(40)
    expect(joined[1].client.frames.filter((f) => f.op === 'message')).toHaveLength(3)
  })

  it('keeps host stores within the process-wide budget', async () => {
    await restart({ storeBudgetBytes: 1000 })
    const a = await join(ALICE)
    a.client.send({ op: 'store', key: 'one', value: 'x'.repeat(600) })
    a.client.send({ op: 'store', key: 'two', value: 'x'.repeat(600) })
    expect(await a.client.next('error')).toMatchObject({ code: 'STORE_FULL' })
  })

  it('hands every store key to a new host, __proto__ included', async () => {
    const a = await join(ALICE)
    const b = await join(BOB)
    a.client.send({ op: 'store', key: '__proto__', value: { round: 2 } })
    await sleep(20)
    a.client.close()
    const promoted = await b.client.next('host')
    expect(Object.keys(promoted.store!)).toEqual(['__proto__'])
  })

  it('closes a member whose token no longer verifies on readmit', async () => {
    await restart({ readmitMs: 50 })
    const a = await join(ALICE)
    const b = await join(BOB)
    deps.signedOut.add(BOB)
    expect(await b.client.next('error')).toMatchObject({ code: 'UNAUTHORIZED' })
    expect((await b.client.closed).code).toBe(CLOSE.UNAUTHORIZED)
    expect(await a.client.next('leave')).toMatchObject({ id: BOB, reason: 'removed' })
  })

  it('removes members after repeated admission failures', async () => {
    await restart({ readmitMs: 30 })
    const a = await join(ALICE)
    deps.admitError = true
    expect(await a.client.next('error')).toMatchObject({ code: 'REFUSED', refusal: 'UNAVAILABLE' })
  })

  it('closes a hello the token check does not answer in time', async () => {
    await restart({ depTimeoutMs: 40 })
    deps.stall = true
    const client = await open()
    client.send({ op: 'hello', v: 1, token: `token-${ALICE}`, session: SESSION })
    expect(await client.next('error')).toMatchObject({ code: 'UNAVAILABLE' })
    expect((await client.closed).code).toBe(CLOSE.UNAVAILABLE)
  })

  it('rate-limits upgrades per address', async () => {
    await restart({ upgradeBurst: 2, upgradesPerSecond: 0.001 })
    await open()
    await open()
    const ws = new WebSocket(url)
    const status = await new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
    expect(status).toBe(429)
  })
})
