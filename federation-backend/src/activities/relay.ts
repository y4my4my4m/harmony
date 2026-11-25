/**
 * Activity relay: one WebSocket per member of an activity session, game-agnostic.
 *
 * A connection opens with `hello` (token, session) within helloTimeoutMs. The token names a local
 * profile; activity_session_admit decides whether it may join. The relay then forwards what members
 * send and holds three things per session in memory: the shared state (host-written, sent to every
 * joiner), the host store (host-written, handed to whoever becomes host) and each member's public
 * state. Nothing is persisted beyond the database row: a restart of this process starts every
 * session over from an empty state.
 *
 * Host: the first member to connect. A host that disconnects keeps the role for hostGraceMs; then
 * the connected member that joined earliest takes it, players before spectators. A session with
 * nobody connected for emptyGraceMs ends; one whose last member closed with LEFT (Leave in the
 * client) ends at once. A dropped connection or a page reload closes otherwise and keeps the grace.
 *
 * The database row hears every membership change (activity_session_sync, debounced) and a heartbeat
 * every heartbeatMs; every readmitMs each member's token is checked and the member admitted again,
 * so signing out, leaving a conversation or call, losing a channel or the app being turned off
 * removes them within that time. At most readmitConcurrency checks run at once in this process; a
 * pass slower than readmitMs delays its session's next one. A member whose token or admission cannot
 * be checked ADMIT_FAILURES times in a row is disconnected with UNAVAILABLE, which its client retries.
 *
 * Players: a joiner plays while fewer than max_players play, else spectates; spectators never host.
 * Outbound bytes are charged to the sender: a frame fanned out to n members costs n times its size.
 * Host stores share storeBudgetBytes across every session of this process.
 */

import type { IncomingMessage, Server } from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  CLOSE,
  MEMBER_STATE_MAX_BYTES,
  MESSAGE_MAX_BYTES,
  NAME_EMOJIS_MAX,
  PROTOCOL_VERSION,
  RATE_BYTES_BURST,
  RATE_BYTES_PER_SECOND,
  RATE_MESSAGES_BURST,
  RATE_MESSAGES_PER_SECOND,
  RELAY_FRAME_MAX_BYTES,
  STATE_MAX_BYTES,
  STORE_KEY_MAX_LENGTH,
  STORE_MAX_BYTES,
  STORE_MAX_KEYS,
  STORE_VALUE_MAX_BYTES,
  type ClientFrame,
  type EndReason,
  type Json,
  type MemberInfo,
  type NameEmoji,
  type RelayErrorCode,
  type RelayFrame,
  type SessionContext,
  type SessionInfo,
} from './protocol.js'
import { Timeout, within } from './within.js'

export const RELAY_PATHS = ['/activities/socket', '/api/federation/activities/socket']

export interface AdmittedSession {
  id: string
  app_id: string
  context: SessionContext
  started_by: string | null
  max_players: number
  min_players: number
}

export interface Admission {
  refusal?: string
  session?: AdmittedSession
  member?: {
    id: string
    username: string | null
    display_name: string | null
    avatar_url: string | null
    display_name_emojis?: unknown
  }
  can_end?: boolean
}

export interface RelayDeps {
  /**
   * Local profile of a valid access token, expiresAt in epoch ms; null for a refused one. Throws when
   * the token cannot be checked.
   */
  verifyToken(token: string): Promise<{ profileId: string; expiresAt: number | null } | null>
  admit(sessionId: string, profileId: string): Promise<Admission>
  sync(sessionId: string, members: string[], host: string | null): Promise<boolean>
  finish(sessionId: string, reason: EndReason): Promise<void>
}

export interface RelayLog {
  info(message: string): void
  warn(message: string): void
}

export interface RelayOptions {
  helloTimeoutMs: number
  hostGraceMs: number
  emptyGraceMs: number
  heartbeatMs: number
  readmitMs: number
  syncDebounceMs: number
  tokenGraceMs: number
  pingIntervalMs: number
  maxConnections: number
  maxConnectionsPerIp: number
  spectatorSlots: number
  /** Largest send buffer a connection may hold before it is closed as too slow. */
  maxBufferedBytes: number
  /** Bytes queued for sending across all connections; past it a slow reader is closed instead. */
  bufferBudgetBytes: number
  /** Sockets that have not said hello: process-wide and per address. */
  maxPendingConnections: number
  maxPendingPerAddress: number
  /** verifyToken and admit answers slower than this close the connection (4013). */
  depTimeoutMs: number
  /** Members checked at a time on readmit, across every session. */
  readmitConcurrency: number
  /** WebSocket upgrades per address: sustained per second and burst. */
  upgradesPerSecond: number
  upgradeBurst: number
  maxSessions: number
  /** Host store bytes across all sessions. */
  storeBudgetBytes: number
  /** Browser origins allowed to open a socket; a request without Origin passes. */
  allowedOrigins: string[] | null
  clientIp: (req: IncomingMessage) => string
  now: () => number
  log: RelayLog
}

const DEFAULTS: RelayOptions = {
  helloTimeoutMs: 10_000,
  hostGraceMs: 8_000,
  emptyGraceMs: 60_000,
  heartbeatMs: 60_000,
  readmitMs: 30_000,
  syncDebounceMs: 1_000,
  tokenGraceMs: 30_000,
  pingIntervalMs: 30_000,
  maxConnections: 5_000,
  maxConnectionsPerIp: 24,
  spectatorSlots: 16,
  maxBufferedBytes: 16 * 1024 * 1024,
  bufferBudgetBytes: 128 * 1024 * 1024,
  maxPendingConnections: 256,
  maxPendingPerAddress: 8,
  depTimeoutMs: 8_000,
  readmitConcurrency: 16,
  upgradesPerSecond: 1,
  upgradeBurst: 20,
  maxSessions: 2_000,
  storeBudgetBytes: 256 * 1024 * 1024,
  allowedOrigins: null,
  clientIp: (req) => req.socket.remoteAddress ?? 'unknown',
  now: () => Date.now(),
  log: { info: () => {}, warn: () => {} },
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TARGETS = 64
/** Close code and reason of a member leaving on purpose (relayConnection.ts stop()). */
export const LEFT = { code: 1000, reason: 'left' } as const
/** A reader holding more than this unsent is closed once the process-wide budget is reached. */
const SLOW_READER_BYTES = 256 * 1024

/**
 * The address limits are kept per: an IPv4 address, or the /64 of an IPv6 address, the block one
 * subscriber holds. An IPv4-mapped IPv6 address counts as its IPv4 address.
 */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return mapped[1]
  const bare = ip.split('%')[0].toLowerCase()
  if (isIP(bare) !== 6) return ip
  const width = (parts: string[]) => parts.reduce((n, part) => n + (part.includes('.') ? 2 : 1), 0)
  const [head, tail] = bare.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail === undefined ? [] : tail ? tail.split(':') : []
  const zeros = bare.includes('::') ? Array(8 - width(headParts) - width(tailParts)).fill('0') : []
  const groups = [...headParts, ...zeros, ...tailParts].slice(0, 4).map((g) => parseInt(g, 16).toString(16))
  return `${groups.join(':')}::/64`
}
const STRIKE_WINDOW_MS = 10_000
const ADMIT_FAILURES = 3
/** Members of one session checked at a time on readmit; readmitConcurrency bounds all sessions together. */
const READMIT_CONCURRENCY = 8
/** Profiles a session remembers (join order, member state) across reconnects. */
const SEEN_LIMIT = 256
/** How long an ended session id is refused, ms. */
const DROPPED_MS = 10 * 60_000

/** True for a request the relay upgrades. */
export function isRelayUpgrade(req: IncomingMessage): boolean {
  return RELAY_PATHS.includes((req.url ?? '').split('?')[0])
}

/**
 * Answers an upgrade request over HTTP and closes its socket. Node removes its own listeners before
 * 'upgrade': a reset here without one is an uncaught error, and the socket is half-open after end().
 */
function refuseUpgrade(socket: Duplex, status: string, headers = ''): void {
  socket.on('error', () => socket.destroy())
  socket.once('finish', () => socket.destroy())
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${headers}\r\n`)
}

/** Token bucket: `rate` per second, holding at most `burst`. */
class Bucket {
  private tokens: number
  private at: number
  constructor(private readonly rate: number, private readonly burst: number, now: number) {
    this.tokens = burst
    this.at = now
  }
  full(): boolean {
    return this.tokens >= this.burst
  }

  take(amount: number, now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate)
    this.at = now
    if (this.tokens < amount) return false
    this.tokens -= amount
    return true
  }
}

/** At most `free` holders at a time; waiters take their turn in order. */
class Slots {
  private readonly waiting: Array<() => void> = []
  constructor(private free: number) {}

  async take(): Promise<void> {
    if (this.free > 0) this.free--
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  give(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free++
  }
}

interface Connection {
  ws: WebSocket
  ip: string
  profileId: string | null
  session: Session | null
  member: MemberInfo | null
  canEnd: boolean
  messages: Bucket
  bytes: Bucket
  strikes: number
  lastStrike: number
  /** The latest token this connection presented, checked again on every readmit. */
  token: string | null
  admitFailures: number
  alive: boolean
  helloTimer: ReturnType<typeof setTimeout> | null
  tokenTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  /** Counted against the pending caps until hello. */
  pending: boolean
}

interface Seen {
  joinedAt: number
  state: Json
}

class Session {
  readonly conns = new Map<string, Connection>()
  /** Every profile that has joined, in join order, kept across reconnects. */
  readonly seen = new Map<string, Seen>()
  host: string | null = null
  state: Json = null
  readonly store = new Map<string, { value: Json; bytes: number }>()
  storeBytes = 0
  ended = false
  hostTimer: ReturnType<typeof setTimeout> | null = null
  emptyTimer: ReturnType<typeof setTimeout> | null = null
  syncTimer: ReturnType<typeof setTimeout> | null = null
  heartbeat: ReturnType<typeof setInterval> | null = null
  readmit: ReturnType<typeof setInterval> | null = null
  /** A readmit pass is running. */
  readmitting = false

  constructor(readonly info: SessionInfo) {}

  members(): MemberInfo[] {
    return [...this.conns.values()].map((c) => c.member!).sort((a, b) => a.joinedAt - b.joinedAt)
  }

  players(): number {
    let n = 0
    for (const c of this.conns.values()) if (!c.member!.spectator) n++
    return n
  }

  /** Own properties for every key, `__proto__` included. */
  storeSnapshot(): Record<string, Json> {
    return Object.fromEntries([...this.store].map(([key, entry]) => [key, entry.value]))
  }
}

const EMOJI_NAME = /^[a-zA-Z0-9_+-]{1,64}$/

/**
 * activity_session_admit's display_name_emojis as name emojis: entries with a shortcode name and an
 * http(s) or root-relative url of at most 2048 characters, the first NAME_EMOJIS_MAX of them.
 */
export function nameEmojis(raw: unknown): NameEmoji[] {
  if (!Array.isArray(raw)) return []
  const out: NameEmoji[] = []
  for (const entry of raw) {
    if (out.length >= NAME_EMOJIS_MAX) break
    if (!entry || typeof entry !== 'object') continue
    const { name, url } = entry as { name?: unknown; url?: unknown }
    if (typeof name !== 'string' || !EMOJI_NAME.test(name)) continue
    if (typeof url !== 'string' || url.length > 2048 || !/^(https?:\/\/|\/(?!\/))/i.test(url)) continue
    out.push({ name, url })
  }
  return out
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function jsonSize(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? Infinity : byteLength(text)
  } catch {
    return Infinity
  }
}

function isJson(value: unknown): value is Json {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'object'
}

export class ActivityRelay {
  private readonly options: RelayOptions
  private readonly wss: WebSocketServer
  private readonly sessions = new Map<string, Session>()
  private readonly connections = new Set<Connection>()
  private readonly perIp = new Map<string, number>()
  private readonly pendingPerIp = new Map<string, number>()
  private pending = 0
  private queuedBytes = 0
  private readonly upgrades = new Map<string, Bucket>()
  private readonly dropped = new Map<string, number>()
  private storeBytes = 0
  private readonly readmitSlots: Slots
  private pinger: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: RelayDeps, options: Partial<RelayOptions> = {}) {
    this.options = { ...DEFAULTS, ...options }
    this.readmitSlots = new Slots(this.options.readmitConcurrency)
    this.wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_FRAME_MAX_BYTES, perMessageDeflate: false })
    this.pinger = setInterval(() => this.pingAll(), this.options.pingIntervalMs)
    this.pinger.unref?.()
  }

  /**
   * Takes upgrade requests for RELAY_PATHS. A server created with `shouldUpgradeCallback:
   * isRelayUpgrade` (Node 24.9) serves every other one as the ordinary request it also is; one that
   * reaches this listener is refused with 400.
   */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (isRelayUpgrade(req)) this.handleUpgrade(req, socket, head)
      else refuseUpgrade(socket, '400 Bad Request')
    })
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin
    if (origin && this.options.allowedOrigins && !this.options.allowedOrigins.includes(origin)) {
      refuseUpgrade(socket, '403 Forbidden')
      return
    }
    const ip = addressKey(this.options.clientIp(req))
    let bucket = this.upgrades.get(ip)
    if (!bucket) this.upgrades.set(ip, (bucket = new Bucket(this.options.upgradesPerSecond, this.options.upgradeBurst, this.options.now())))
    if (!bucket.take(1, this.options.now())) {
      refuseUpgrade(socket, '429 Too Many Requests', 'Retry-After: 10\r\n')
      return
    }
    if (this.connections.size >= this.options.maxConnections || (this.perIp.get(ip) ?? 0) >= this.options.maxConnectionsPerIp
      || this.pending >= this.options.maxPendingConnections || (this.pendingPerIp.get(ip) ?? 0) >= this.options.maxPendingPerAddress) {
      refuseUpgrade(socket, '503 Service Unavailable', 'Retry-After: 10\r\n')
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, ip))
  }

  /** Sessions held in memory, for health and tests. */
  get sessionCount(): number {
    return this.sessions.size
  }

  get connectionCount(): number {
    return this.connections.size
  }

  async close(): Promise<void> {
    if (this.pinger) clearInterval(this.pinger)
    for (const session of [...this.sessions.values()]) this.dropSession(session)
    for (const conn of [...this.connections]) this.closeConn(conn, CLOSE.GOING_AWAY, 'relay closing')
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }

  /* -------------------------------------------------------------------------------------------- */

  private accept(ws: WebSocket, ip: string): void {
    const now = this.options.now()
    const conn: Connection = {
      ws,
      ip,
      profileId: null,
      session: null,
      member: null,
      canEnd: false,
      messages: new Bucket(RATE_MESSAGES_PER_SECOND, RATE_MESSAGES_BURST, now),
      bytes: new Bucket(RATE_BYTES_PER_SECOND, RATE_BYTES_BURST, now),
      strikes: 0,
      lastStrike: 0,
      token: null,
      admitFailures: 0,
      alive: true,
      helloTimer: null,
      tokenTimer: null,
      closed: false,
      pending: true,
    }
    this.connections.add(conn)
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1)
    this.pending++
    this.pendingPerIp.set(ip, (this.pendingPerIp.get(ip) ?? 0) + 1)
    conn.helloTimer = setTimeout(() => this.closeConn(conn, CLOSE.NO_HELLO, 'no hello'), this.options.helloTimeoutMs)

    ws.on('pong', () => { conn.alive = true })
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      this.onMessage(conn, raw, isBinary).catch((error: Error) => {
        this.options.log.warn(`activity relay: ${error.message}`)
        this.closeConn(conn, CLOSE.UNAVAILABLE, 'relay error')
      })
    })
    ws.on('close', (code: number, reason: Buffer) => this.onClose(conn, code === LEFT.code && reason.toString() === LEFT.reason))
    ws.on('error', () => this.closeConn(conn, CLOSE.BAD_FRAME, 'socket error'))
  }

  private async onMessage(conn: Connection, raw: RawData, isBinary: boolean): Promise<void> {
    if (conn.closed) return
    const size = Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : (raw as Buffer).byteLength
    const now = this.options.now()
    if (!conn.messages.take(1, now) || !conn.bytes.take(size, now)) {
      // Strikes count refusals within STRIKE_WINDOW_MS of each other.
      if (now - conn.lastStrike > STRIKE_WINDOW_MS) conn.strikes = 0
      conn.lastStrike = now
      conn.strikes++
      this.error(conn, 'RATE_LIMITED')
      if (conn.strikes > 20) this.closeConn(conn, CLOSE.RATE_LIMITED, 'rate limited')
      return
    }
    if (isBinary) return this.badFrame(conn, 'text frames only')

    let frame: ClientFrame
    try {
      frame = JSON.parse(raw.toString()) as ClientFrame
    } catch {
      return this.badFrame(conn, 'not JSON')
    }
    if (!frame || typeof frame !== 'object' || typeof frame.op !== 'string') return this.badFrame(conn, 'no op')

    if (frame.op === 'hello') return this.hello(conn, frame)
    if (frame.op === 'ping') {
      this.send(conn, { op: 'pong', t: Number(frame.t) || 0, serverTime: now })
      return
    }
    if (frame.op === 'auth') return this.reauth(conn, frame.token)

    const session = conn.session
    if (!session || !conn.member || session.ended) return
    const me = conn.member.id
    // A removed or replaced connection keeps emitting frames until its close completes.
    if (session.conns.get(me) !== conn) return

    switch (frame.op) {
      case 'send': {
        if (!isJson(frame.data) || jsonSize(frame.data) > MESSAGE_MAX_BYTES) return this.error(conn, 'TOO_LARGE')
        let targets: Connection[]
        if (frame.to === undefined) {
          targets = [...session.conns.values()].filter((other) => other !== conn)
        } else if (frame.to === 'host') {
          const host = session.host ? session.conns.get(session.host) : undefined
          targets = host && host !== conn ? [host] : []
        } else if (Array.isArray(frame.to) && frame.to.length <= MAX_TARGETS) {
          targets = []
          for (const id of new Set(frame.to)) {
            if (typeof id !== 'string' || id === me) continue
            const target = session.conns.get(id)
            if (target) targets.push(target)
          }
        } else {
          return this.badFrame(conn, 'bad target')
        }
        if (!this.chargeFanOut(conn, size, targets.length, now)) return
        const out = JSON.stringify({ op: 'message', from: me, data: frame.data } satisfies RelayFrame)
        for (const target of targets) this.sendRaw(target, out)
        return
      }
      case 'state': {
        if (session.host !== me) return this.error(conn, 'NOT_HOST')
        if (!isJson(frame.state) || jsonSize(frame.state) > STATE_MAX_BYTES) return this.error(conn, 'TOO_LARGE')
        if (!this.chargeFanOut(conn, size, session.conns.size - 1, now)) return
        session.state = frame.state
        this.broadcast(session, { op: 'state', state: frame.state, from: me }, conn)
        return
      }
      case 'store': {
        if (session.host !== me) return this.error(conn, 'NOT_HOST')
        if (typeof frame.key !== 'string' || frame.key.length < 1 || frame.key.length > STORE_KEY_MAX_LENGTH) return this.badFrame(conn, 'bad key')
        const old = session.store.get(frame.key)
        if (frame.value === undefined) {
          if (old) {
            session.store.delete(frame.key)
            session.storeBytes -= old.bytes
            this.storeBytes -= old.bytes
          }
          return
        }
        const bytes = jsonSize(frame.value)
        if (!isJson(frame.value) || bytes > STORE_VALUE_MAX_BYTES) return this.error(conn, 'TOO_LARGE')
        const delta = bytes - (old?.bytes ?? 0)
        if (session.storeBytes + delta > STORE_MAX_BYTES
          || this.storeBytes + delta > this.options.storeBudgetBytes
          || (!old && session.store.size >= STORE_MAX_KEYS)) return this.error(conn, 'STORE_FULL')
        session.store.set(frame.key, { value: frame.value, bytes })
        session.storeBytes += delta
        this.storeBytes += delta
        return
      }
      case 'me': {
        if (!isJson(frame.state) || jsonSize(frame.state) > MEMBER_STATE_MAX_BYTES) return this.error(conn, 'TOO_LARGE')
        if (!this.chargeFanOut(conn, size, session.conns.size - 1, now)) return
        conn.member.state = frame.state
        const seen = session.seen.get(me)
        if (seen) seen.state = frame.state
        this.broadcast(session, { op: 'member', id: me, state: frame.state }, conn)
        return
      }
      case 'end': {
        if (session.host !== me && !conn.canEnd) return this.error(conn, 'NOT_HOST')
        this.endSession(session, 'host_ended')
        return
      }
      default:
        return this.badFrame(conn, 'unknown op')
    }
  }

  private async hello(conn: Connection, frame: Extract<ClientFrame, { op: 'hello' }>): Promise<void> {
    if (conn.profileId) return this.badFrame(conn, 'hello twice')
    if (frame.v !== PROTOCOL_VERSION) return this.refuse(conn, 'UNSUPPORTED_VERSION')
    if (typeof frame.token !== 'string' || typeof frame.session !== 'string' || !UUID.test(frame.session)) {
      return this.badFrame(conn, 'bad hello')
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    conn.helloTimer = null
    this.settlePending(conn)
    // Claimed before the awaits: a second hello on this socket is refused above.
    conn.profileId = 'pending'

    const verified = await this.ask(conn, () => this.deps.verifyToken(frame.token))
    if (verified === undefined || this.gone(conn)) return
    if (!verified) {
      this.send(conn, { op: 'error', code: 'UNAUTHORIZED', fatal: true })
      return this.closeConn(conn, CLOSE.UNAUTHORIZED, 'unauthorized')
    }
    conn.profileId = verified.profileId
    conn.token = frame.token
    this.armToken(conn, verified.expiresAt)

    const admission = await this.ask(conn, () => this.deps.admit(frame.session, verified.profileId))
    if (admission === undefined || this.gone(conn)) return
    if (admission.refusal || !admission.session || !admission.member) {
      return this.refuse(conn, admission.refusal ?? 'NOT_FOUND')
    }
    // The session may have ended in this process while the database answered.
    if (this.dropped.has(admission.session.id)) return this.refuse(conn, 'ENDED')
    if (!this.sessions.has(admission.session.id) && this.sessions.size >= this.options.maxSessions) {
      this.send(conn, { op: 'error', code: 'UNAVAILABLE', fatal: true })
      return this.closeConn(conn, CLOSE.UNAVAILABLE, 'busy')
    }

    const session = this.sessionFor(admission.session)
    const profileId = verified.profileId

    const previous = session.conns.get(profileId)
    if (previous) {
      this.send(previous, { op: 'error', code: 'REPLACED', fatal: true })
      session.conns.delete(profileId)
      this.closeConn(previous, CLOSE.REPLACED, 'replaced')
    }

    const spectator = session.players() >= session.info.maxPlayers
    if (spectator && session.conns.size >= session.info.maxPlayers + this.options.spectatorSlots) {
      return this.refuse(conn, 'FULL')
    }
    const seen = session.seen.get(profileId)
    const now = this.options.now()
    const member: MemberInfo = {
      id: profileId,
      name: admission.member.display_name || admission.member.username || 'Member',
      username: admission.member.username ?? '',
      avatarUrl: admission.member.avatar_url,
      nameEmojis: nameEmojis(admission.member.display_name_emojis),
      joinedAt: seen?.joinedAt ?? now,
      spectator,
      state: seen?.state ?? null,
    }
    this.remember(session, profileId, { joinedAt: member.joinedAt, state: member.state })
    conn.member = member
    conn.session = session
    conn.canEnd = admission.can_end === true
    session.conns.set(profileId, conn)

    if (session.emptyTimer) {
      clearTimeout(session.emptyTimer)
      session.emptyTimer = null
    }

    let promoted = false
    const hostAbsent = session.host === null || (!session.conns.has(session.host) && !session.hostTimer)
    if (!spectator && hostAbsent) {
      session.host = profileId
      promoted = true
    } else if (session.host === profileId && session.hostTimer) {
      clearTimeout(session.hostTimer)
      session.hostTimer = null
    }

    this.send(conn, {
      op: 'welcome',
      you: member,
      session: session.info,
      members: session.members(),
      host: session.host ?? '',
      state: session.state,
      ...(session.host === profileId ? { store: session.storeSnapshot() } : {}),
      canEnd: conn.canEnd,
      serverTime: now,
    })
    this.broadcast(session, { op: 'join', member }, conn)
    if (promoted) this.broadcast(session, { op: 'host', id: profileId }, conn)
    this.scheduleSync(session)
  }

  private async reauth(conn: Connection, token: unknown): Promise<void> {
    if (!conn.member || typeof token !== 'string') return this.badFrame(conn, 'auth before hello')
    const verified = await this.ask(conn, () => this.deps.verifyToken(token))
    if (verified === undefined || this.gone(conn)) return
    if (!verified || verified.profileId !== conn.member.id) {
      this.send(conn, { op: 'error', code: 'UNAUTHORIZED', fatal: true })
      return this.closeConn(conn, CLOSE.UNAUTHORIZED, 'unauthorized')
    }
    conn.token = token
    this.armToken(conn, verified.expiresAt)
  }

  /** A dependency answer within depTimeoutMs; undefined (connection closed, 4013) otherwise. */
  private async ask<T>(conn: Connection, call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await within(call(), this.options.depTimeoutMs)
    } catch (error) {
      if (!this.gone(conn)) {
        this.send(conn, { op: 'error', code: 'UNAVAILABLE', fatal: true })
        this.closeConn(conn, CLOSE.UNAVAILABLE, error instanceof Timeout ? 'timeout' : 'unavailable')
      }
      return undefined
    }
  }

  /** Keeps at most SEEN_LIMIT profiles, dropping the earliest that is not connected. */
  private remember(session: Session, id: string, seen: Seen): void {
    if (!session.seen.has(id) && session.seen.size >= SEEN_LIMIT) {
      for (const key of session.seen.keys()) {
        if (!session.conns.has(key)) {
          session.seen.delete(key)
          break
        }
      }
    }
    session.seen.set(id, seen)
  }

  /** Charges the bytes a frame of `size` costs when fanned out to `recipients`; false when refused. */
  private chargeFanOut(conn: Connection, size: number, recipients: number, now: number): boolean {
    if (recipients <= 1 || conn.bytes.take(size * (recipients - 1), now)) return true
    this.error(conn, 'RATE_LIMITED')
    return false
  }

  private armToken(conn: Connection, expiresAt: number | null): void {
    if (conn.tokenTimer) clearTimeout(conn.tokenTimer)
    conn.tokenTimer = null
    if (expiresAt === null) return
    const wait = Math.max(0, expiresAt - this.options.now()) + this.options.tokenGraceMs
    conn.tokenTimer = setTimeout(() => {
      this.send(conn, { op: 'error', code: 'UNAUTHORIZED', message: 'token expired', fatal: true })
      this.closeConn(conn, CLOSE.UNAUTHORIZED, 'token expired')
    }, wait)
    conn.tokenTimer.unref?.()
  }

  private sessionFor(admitted: AdmittedSession): Session {
    let session = this.sessions.get(admitted.id)
    if (session) return session
    session = new Session({
      id: admitted.id,
      appId: admitted.app_id,
      context: admitted.context,
      startedBy: admitted.started_by,
      maxPlayers: Math.max(1, Math.min(64, Number(admitted.max_players) || 16)),
      minPlayers: Math.max(1, Number(admitted.min_players) || 1),
    })
    this.sessions.set(admitted.id, session)
    const s = session
    s.heartbeat = setInterval(() => this.heartbeat(s), this.options.heartbeatMs)
    s.heartbeat.unref?.()
    s.readmit = setInterval(() => { this.readmitAll(s).catch(() => {}) }, this.options.readmitMs)
    s.readmit.unref?.()
    return session
  }

  private onClose(conn: Connection, left = false): void {
    conn.closed = true
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    if (conn.tokenTimer) clearTimeout(conn.tokenTimer)
    if (this.connections.delete(conn)) {
      const n = (this.perIp.get(conn.ip) ?? 1) - 1
      if (n <= 0) this.perIp.delete(conn.ip)
      else this.perIp.set(conn.ip, n)
      this.settlePending(conn)
    }
    const session = conn.session
    if (!session || !conn.member || session.ended) return
    if (session.conns.get(conn.member.id) !== conn) return
    this.removeMember(session, conn.member.id, 'left', left)
  }

  /** `final`: the member left on purpose; a session it leaves empty ends without the grace. */
  private removeMember(session: Session, id: string, reason: 'left' | 'timeout' | 'removed', final = false): void {
    session.conns.delete(id)
    this.broadcast(session, { op: 'leave', id, reason })
    if (reason === 'removed') session.seen.delete(id)

    if (session.conns.size === 0) {
      if (session.hostTimer) clearTimeout(session.hostTimer)
      session.hostTimer = null
      if (final) {
        this.endSession(session, 'empty')
        return
      }
      session.emptyTimer = setTimeout(() => this.endSession(session, 'empty'), this.options.emptyGraceMs)
      session.emptyTimer.unref?.()
    } else if (session.host === id) {
      if (reason === 'removed') this.promote(session)
      else {
        if (session.hostTimer) clearTimeout(session.hostTimer)
        session.hostTimer = setTimeout(() => {
          session.hostTimer = null
          if (session.host && !session.conns.has(session.host)) this.promote(session)
        }, this.options.hostGraceMs)
        session.hostTimer.unref?.()
      }
    }
    this.scheduleSync(session)
  }

  private promote(session: Session): void {
    const next = session.members().find((m) => !m.spectator)
    if (!next) return
    session.host = next.id
    for (const conn of session.conns.values()) {
      this.send(conn, conn.member!.id === next.id
        ? { op: 'host', id: next.id, store: session.storeSnapshot() }
        : { op: 'host', id: next.id })
    }
    this.scheduleSync(session)
  }

  private endSession(session: Session, reason: EndReason, record = true): void {
    if (session.ended) return
    this.broadcast(session, { op: 'ended', reason })
    this.dropSession(session)
    if (record) {
      this.deps.finish(session.info.id, reason).catch((error: Error) => {
        this.options.log.warn(`activity relay: finish ${session.info.id} failed: ${error.message}`)
      })
    }
  }

  private dropSession(session: Session): void {
    session.ended = true
    this.dropped.set(session.info.id, this.options.now())
    this.storeBytes -= session.storeBytes
    session.storeBytes = 0
    session.store.clear()
    for (const timer of [session.hostTimer, session.emptyTimer, session.syncTimer]) if (timer) clearTimeout(timer)
    if (session.heartbeat) clearInterval(session.heartbeat)
    if (session.readmit) clearInterval(session.readmit)
    for (const conn of [...session.conns.values()]) this.closeConn(conn, CLOSE.ENDED, 'ended')
    session.conns.clear()
    this.sessions.delete(session.info.id)
  }

  private scheduleSync(session: Session): void {
    if (session.syncTimer || session.ended) return
    session.syncTimer = setTimeout(() => {
      session.syncTimer = null
      this.syncNow(session)
    }, this.options.syncDebounceMs)
    session.syncTimer.unref?.()
  }

  private heartbeat(session: Session): void {
    if (session.conns.size > 0) this.syncNow(session)
  }

  private syncNow(session: Session): void {
    if (session.ended) return
    this.deps.sync(session.info.id, [...session.conns.keys()], session.host)
      .then((active) => {
        if (!active && !session.ended) this.endSession(session, 'ended', false)
      })
      .catch((error: Error) => this.options.log.warn(`activity relay: sync ${session.info.id} failed: ${error.message}`))
  }

  /** One pass at a time: a tick that finds the previous one running is skipped. */
  private async readmitAll(session: Session): Promise<void> {
    if (session.readmitting) return
    session.readmitting = true
    try {
      const queue = [...session.conns]
      const worker = async () => {
        for (let next = queue.shift(); next && !session.ended; next = queue.shift()) {
          const [id, conn] = next
          await this.readmitSlots.take()
          try {
            if (!session.ended && session.conns.get(id) === conn) await this.readmitMember(session, id, conn)
          } finally {
            this.readmitSlots.give()
          }
        }
      }
      await Promise.all(Array.from({ length: READMIT_CONCURRENCY }, worker))
    } finally {
      session.readmitting = false
    }
  }

  private async readmitMember(session: Session, id: string, conn: Connection): Promise<void> {
    let verified: Awaited<ReturnType<RelayDeps['verifyToken']>> | null = null
    let admission: Admission | null = null
    try {
      verified = conn.token ? await within(this.deps.verifyToken(conn.token), this.options.depTimeoutMs) : null
      if (verified && verified.profileId === id) {
        admission = await within(this.deps.admit(session.info.id, id), this.options.depTimeoutMs)
      }
    } catch {
      if (session.ended || session.conns.get(id) !== conn) return
      if (++conn.admitFailures >= ADMIT_FAILURES) {
        this.send(conn, { op: 'error', code: 'UNAVAILABLE', fatal: true })
        this.removeMember(session, id, 'timeout')
        this.closeConn(conn, CLOSE.UNAVAILABLE, 'unavailable')
      }
      return
    }
    if (session.ended || session.conns.get(id) !== conn) return
    if (!verified || verified.profileId !== id) {
      this.send(conn, { op: 'error', code: 'UNAUTHORIZED', fatal: true })
      this.removeMember(session, id, 'removed')
      this.closeConn(conn, CLOSE.UNAUTHORIZED, 'unauthorized')
      return
    }
    conn.admitFailures = 0
    if (admission!.refusal === 'ENDED') return this.endSession(session, 'ended', false)
    if (admission!.refusal === 'ACTIVITY_APP_UNAVAILABLE') return this.endSession(session, 'disabled')
    if (admission!.refusal) this.expel(session, conn, id, admission!.refusal)
    else conn.canEnd = admission!.can_end === true
  }

  private expel(session: Session, conn: Connection, id: string, refusal: string): void {
    this.send(conn, { op: 'error', code: 'REFUSED', refusal, fatal: true })
    this.removeMember(session, id, 'removed')
    this.closeConn(conn, CLOSE.REFUSED, refusal)
  }

  private pingAll(): void {
    const now = this.options.now()
    for (const [id, at] of this.dropped) if (now - at > DROPPED_MS) this.dropped.delete(id)
    // A bucket refilled to its burst is the same as no bucket.
    for (const [ip, bucket] of this.upgrades) if (bucket.take(0, now) && bucket.full()) this.upgrades.delete(ip)
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.ws.terminate()
        continue
      }
      conn.alive = false
      try { conn.ws.ping() } catch { /* closing */ }
    }
  }

  /* -------------------------------------------------------------------------------------------- */

  private gone(conn: Connection): boolean {
    return conn.closed || conn.ws.readyState !== WebSocket.OPEN
  }

  private refuse(conn: Connection, refusal: string): void {
    this.send(conn, { op: 'error', code: 'REFUSED', refusal, fatal: true })
    this.closeConn(conn, CLOSE.REFUSED, refusal)
  }

  private badFrame(conn: Connection, message: string): void {
    this.send(conn, { op: 'error', code: 'BAD_FRAME', message, fatal: true })
    this.closeConn(conn, CLOSE.BAD_FRAME, message)
  }

  private error(conn: Connection, code: RelayErrorCode): void {
    this.send(conn, { op: 'error', code })
  }

  private broadcast(session: Session, frame: RelayFrame, except?: Connection): void {
    const out = JSON.stringify(frame)
    for (const conn of session.conns.values()) if (conn !== except) this.sendRaw(conn, out)
  }

  private send(conn: Connection, frame: RelayFrame): void {
    this.sendRaw(conn, JSON.stringify(frame))
  }

  private sendRaw(conn: Connection, text: string): void {
    if (conn.closed || conn.ws.readyState !== WebSocket.OPEN) return
    const bytes = Buffer.byteLength(text)
    if (conn.ws.bufferedAmount > this.options.maxBufferedBytes
      || (this.queuedBytes + bytes > this.options.bufferBudgetBytes && conn.ws.bufferedAmount > SLOW_READER_BYTES)) {
      this.closeConn(conn, CLOSE.RATE_LIMITED, 'too slow')
      return
    }
    this.queuedBytes += bytes
    // ws calls back once the frame is written, or with an error when the socket closes first.
    conn.ws.send(text, () => { this.queuedBytes -= bytes })
  }

  /** Bytes handed to sockets and not yet written, for health and tests. */
  get queuedByteCount(): number {
    return this.queuedBytes
  }

  /** A socket leaves the pending count at hello or when it closes, whichever comes first. */
  private settlePending(conn: Connection): void {
    if (!conn.pending) return
    conn.pending = false
    this.pending--
    const n = (this.pendingPerIp.get(conn.ip) ?? 1) - 1
    if (n <= 0) this.pendingPerIp.delete(conn.ip)
    else this.pendingPerIp.set(conn.ip, n)
  }

  private closeConn(conn: Connection, code: number, reason: string): void {
    conn.closed = true
    if (conn.ws.readyState === WebSocket.CLOSING || conn.ws.readyState === WebSocket.CLOSED) return
    try {
      conn.ws.close(code, reason.slice(0, 120))
    } catch {
      conn.ws.terminate()
    }
  }
}
