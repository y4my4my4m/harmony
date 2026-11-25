/**
 * Harmony activity SDK, for code running inside an activity frame.
 *
 *   const room = await connect()
 *   room.on('message', (from, data) => ...)
 *   if (room.isHost) room.setState({ phase: 'lobby' })
 *
 * The frame is sandboxed without allow-same-origin and its CSP refuses every network connection;
 * everything an activity learns or sends passes through the Harmony client that embeds it.
 */

import {
  MEMBER_STATE_MAX_BYTES,
  MESSAGE_MAX_BYTES,
  PROTOCOL_VERSION,
  SAVE_MAX_BYTES,
  SAVE_TYPES,
  STATE_MAX_BYTES,
  STORE_KEY_MAX_LENGTH,
  STORE_VALUE_MAX_BYTES,
  jsonBytes,
  type ConnectionStatus,
  type EndReason,
  type FrameMember,
  type FrameToHost,
  type HostToFrame,
  type Json,
  type NamePart,
  type RelayErrorCode,
  type SendTarget,
  type SessionInfo,
  type ThemeInfo,
  type WireMember,
  type WireNamePart,
} from './protocol'

export * from './protocol'

export const SDK_VERSION = '1.0.0'

function toNameParts(parts: WireNamePart[] | undefined): NamePart[] {
  return (parts ?? []).map((part) => ('emoji' in part
    ? { emoji: part.emoji, src: part.image ? URL.createObjectURL(part.image) : null }
    : { text: part.text }))
}

/** Revokes the object URLs a member's avatar and name emojis were given. */
function releaseUrls(member: Pick<FrameMember, 'avatar' | 'nameParts'>): void {
  if (member.avatar) URL.revokeObjectURL(member.avatar)
  for (const part of member.nameParts ?? []) if ('src' in part && part.src) URL.revokeObjectURL(part.src)
}

export interface RoomEvents {
  /** A member connected. */
  join: (member: FrameMember) => void
  /** A member disconnected. */
  leave: (member: FrameMember, reason: 'left' | 'timeout' | 'removed') => void
  /** The host changed; `store` is set when this client became the host. */
  host: (hostId: string, previous: string) => void
  /** A message from another member. */
  message: (from: FrameMember | undefined, data: Json, fromId: string) => void
  /** The host replaced the shared state. */
  state: (state: Json, from: string) => void
  /** A member replaced its public state, or its avatar or name emojis arrived. */
  member: (member: FrameMember) => void
  /** The session ended for everyone. */
  ended: (reason: EndReason) => void
  /** The relay refused something this client sent. */
  error: (code: RelayErrorCode, message?: string) => void
  /** Connection to the relay. While reconnecting, sends are dropped. */
  connection: (status: ConnectionStatus) => void
  /** The client reconnected and replaced members, host, state and store from the relay. */
  resync: () => void
  /** The activity was shown or hidden (minimised panel, background tab). */
  visibility: (visible: boolean) => void
  theme: (theme: ThemeInfo) => void
}

type Listener = (...args: never[]) => void

export class SdkError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'SdkError'
  }
}

export interface Room {
  readonly session: SessionInfo
  readonly me: FrameMember
  /** Connected members in join order, this client included. */
  readonly members: FrameMember[]
  readonly hostId: string
  readonly isHost: boolean
  readonly canEnd: boolean
  readonly state: Json
  /** The host store; empty unless this client is the host. */
  readonly store: ReadonlyMap<string, Json>
  readonly locale: string
  readonly theme: ThemeInfo
  readonly visible: boolean
  readonly connection: ConnectionStatus
  member(id: string): FrameMember | undefined
  /** Relay clock, ms since the epoch. Deadlines in shared state should use it. */
  serverNow(): number
  on<K extends keyof RoomEvents>(event: K, listener: RoomEvents[K]): () => void
  /** To every other member, the host, or the listed members. */
  send(data: Json, to?: SendTarget): void
  /** Host only. */
  setState(state: Json): void
  /** Host only. `undefined` deletes the key. */
  storeSet(key: string, value: Json | undefined): void
  setMyState(state: Json): void
  /** Ends the session for everyone (the host, the starter, or a channel moderator). */
  end(): void
  /** Closes the activity for this account only. */
  leave(): void
  /** Draws the account's attention when the activity is hidden. */
  notify(text: string): void
  /** Hands an image to the client, which saves it as a download. */
  saveImage(blob: Blob, name: string): Promise<boolean>
}

function check(condition: boolean, code: string, message: string): void {
  if (!condition) throw new SdkError(code, message)
}

class RoomImpl implements Room {
  session!: SessionInfo
  hostId = ''
  canEnd = false
  state: Json = null
  store = new Map<string, Json>()
  locale = 'en'
  theme: ThemeInfo = { scheme: 'dark', accent: '#0EA5E9', reducedMotion: false }
  visible = true
  connection: ConnectionStatus = 'connected'
  private you = ''
  private memberMap = new Map<string, FrameMember>()
  private clockOffset = 0
  private listeners = new Map<keyof RoomEvents, Set<Listener>>()
  private saveSeq = 0
  private saves = new Map<number, (ok: boolean) => void>()

  constructor(private readonly parentOrigin: string) {}

  get me(): FrameMember {
    return this.memberMap.get(this.you)!
  }

  get members(): FrameMember[] {
    return [...this.memberMap.values()]
  }

  get isHost(): boolean {
    return this.hostId === this.you
  }

  member(id: string): FrameMember | undefined {
    return this.memberMap.get(id)
  }

  serverNow(): number {
    return Date.now() + this.clockOffset
  }

  on<K extends keyof RoomEvents>(event: K, listener: RoomEvents[K]): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(listener as Listener)
    return () => set!.delete(listener as Listener)
  }

  send(data: Json, to?: SendTarget): void {
    check(jsonBytes(data) <= MESSAGE_MAX_BYTES, 'TOO_LARGE', `A message is at most ${MESSAGE_MAX_BYTES} bytes`)
    this.post({ hp: PROTOCOL_VERSION, t: 'send', data, ...(to ? { to } : {}) })
  }

  setState(state: Json): void {
    check(this.isHost, 'NOT_HOST', 'Only the host writes the shared state')
    check(jsonBytes(state) <= STATE_MAX_BYTES, 'TOO_LARGE', `The state is at most ${STATE_MAX_BYTES} bytes`)
    this.state = state
    this.post({ hp: PROTOCOL_VERSION, t: 'state', state })
  }

  storeSet(key: string, value: Json | undefined): void {
    check(this.isHost, 'NOT_HOST', 'Only the host writes the store')
    check(typeof key === 'string' && key.length > 0 && key.length <= STORE_KEY_MAX_LENGTH, 'BAD_KEY', 'Store keys are 1-128 characters')
    if (value === undefined) {
      this.store.delete(key)
      this.post({ hp: PROTOCOL_VERSION, t: 'store', key })
      return
    }
    check(jsonBytes(value) <= STORE_VALUE_MAX_BYTES, 'TOO_LARGE', `A store value is at most ${STORE_VALUE_MAX_BYTES} bytes`)
    this.store.set(key, value)
    this.post({ hp: PROTOCOL_VERSION, t: 'store', key, value })
  }

  setMyState(state: Json): void {
    check(jsonBytes(state) <= MEMBER_STATE_MAX_BYTES, 'TOO_LARGE', `A member state is at most ${MEMBER_STATE_MAX_BYTES} bytes`)
    const me = this.memberMap.get(this.you)
    if (me) me.state = state
    this.post({ hp: PROTOCOL_VERSION, t: 'me', state })
  }

  end(): void {
    this.post({ hp: PROTOCOL_VERSION, t: 'end' })
  }

  leave(): void {
    this.post({ hp: PROTOCOL_VERSION, t: 'leave' })
  }

  notify(text: string): void {
    this.post({ hp: PROTOCOL_VERSION, t: 'notify', text: String(text).slice(0, 140) })
  }

  saveImage(blob: Blob, name: string): Promise<boolean> {
    check(blob instanceof Blob && (SAVE_TYPES as readonly string[]).includes(blob.type), 'BAD_TYPE', 'Only PNG, JPEG, WebP and GIF images can be saved')
    check(blob.size <= SAVE_MAX_BYTES, 'TOO_LARGE', 'An image to save is at most 10 MB')
    const id = ++this.saveSeq
    return new Promise((resolve) => {
      this.saves.set(id, resolve)
      this.post({ hp: PROTOCOL_VERSION, t: 'save', id, blob, name: String(name).slice(0, 120) })
    })
  }

  /** Applies a message from the client. */
  receive(msg: HostToFrame): void {
    switch (msg.t) {
      case 'init':
        this.session = msg.session
        this.you = msg.you
        this.canEnd = msg.canEnd
        this.locale = msg.locale
        this.theme = msg.theme
        this.visible = msg.visible
        this.replace(msg.members, msg.host, msg.state, msg.store, msg.clockOffset)
        break
      case 'resync':
        this.replace(msg.members, msg.host, msg.state, msg.store, msg.clockOffset)
        this.emit('resync')
        break
      case 'join': {
        const member = this.toMember(msg.member)
        const previous = this.memberMap.get(member.id)
        if (previous) releaseUrls(previous)
        this.memberMap.set(member.id, member)
        this.emit('join', member)
        break
      }
      case 'leave': {
        const member = this.memberMap.get(msg.id)
        if (!member) break
        this.memberMap.delete(msg.id)
        this.emit('leave', member, msg.reason)
        setTimeout(() => releaseUrls(member), 60_000)
        break
      }
      case 'host': {
        const previous = this.hostId
        this.hostId = msg.id
        this.store = new Map(Object.entries(msg.store ?? {}))
        this.emit('host', msg.id, previous)
        break
      }
      case 'message':
        this.emit('message', this.memberMap.get(msg.from), msg.data, msg.from)
        break
      case 'state':
        this.state = msg.state
        this.emit('state', msg.state, msg.from)
        break
      case 'member': {
        const member = this.memberMap.get(msg.id)
        if (!member) break
        member.state = msg.state
        this.emit('member', member)
        break
      }
      case 'profile': {
        const member = this.memberMap.get(msg.id)
        if (!member) break
        const previous = { avatar: member.avatar, nameParts: member.nameParts }
        member.name = msg.name
        member.nameParts = toNameParts(msg.nameParts)
        member.avatar = msg.avatarBlob ? URL.createObjectURL(msg.avatarBlob) : null
        releaseUrls(previous)
        this.emit('member', member)
        break
      }
      case 'ended':
        this.emit('ended', msg.reason)
        break
      case 'error':
        this.emit('error', msg.code, msg.message)
        break
      case 'clock':
        this.clockOffset = msg.clockOffset
        break
      case 'theme':
        this.theme = msg.theme
        this.emit('theme', msg.theme)
        break
      case 'visibility':
        this.visible = msg.visible
        this.emit('visibility', msg.visible)
        break
      case 'connection':
        this.connection = msg.status
        this.emit('connection', msg.status)
        break
      case 'saved':
        this.saves.get(msg.id)?.(msg.ok)
        this.saves.delete(msg.id)
        break
    }
  }

  private replace(members: WireMember[], host: string, state: Json, store: Record<string, Json> | undefined, clockOffset: number): void {
    for (const old of this.memberMap.values()) releaseUrls(old)
    this.memberMap = new Map(members.map((m) => [m.id, this.toMember(m)]))
    this.hostId = host
    this.state = state
    this.store = new Map(Object.entries(store ?? {}))
    this.clockOffset = clockOffset
  }

  private toMember(wire: WireMember): FrameMember {
    const { avatarBlob, nameParts, ...rest } = wire
    return { ...rest, nameParts: toNameParts(nameParts), avatar: avatarBlob ? URL.createObjectURL(avatarBlob) : null }
  }

  private emit(event: keyof RoomEvents, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        ;(listener as (...a: unknown[]) => void)(...args)
      } catch (error) {
        console.error(`[activity] ${event} listener failed`, error)
      }
    }
  }

  private post(msg: FrameToHost): void {
    window.parent.postMessage(msg, this.parentOrigin)
  }
}

/**
 * A message of the embedding client. In a call's pop-out window the parent is that window, whose
 * script runs in the app's realm: its messages carry the app's window as source, the pop-out's
 * opener (a Document Picture-in-Picture window has none), and the app's origin, the pop-out's own.
 * The origin decides: a site that opened Harmony is the opener of the window the frame is docked in.
 */
function fromClient(event: MessageEvent): boolean {
  if (event.source === window.parent) return true
  if (!event.source || event.origin === 'null') return false
  // Absent in Firefox, and 'null' where the frame's referrer policy hides it.
  const app = window.location.ancestorOrigins?.[0]
  if (app && app !== 'null') return event.origin === app
  // The web app serves the frame's document from its own origin.
  try {
    return event.source === window.parent.opener && event.origin === window.location.origin
  } catch {
    return false
  }
}

let pending: Promise<Room> | null = null

/** Resolves once the embedding client has sent the session. One room per frame. */
export function connect(options: { timeoutMs?: number } = {}): Promise<Room> {
  if (pending) return pending
  pending = new Promise<Room>((resolve, reject) => {
    if (window.parent === window) {
      reject(new SdkError('NOT_EMBEDDED', 'An activity runs inside a Harmony client'))
      return
    }
    let room: RoomImpl | null = null
    const timer = setTimeout(() => {
      if (!room) reject(new SdkError('TIMEOUT', 'The Harmony client did not answer'))
    }, options.timeoutMs ?? 15_000)

    window.addEventListener('message', (event: MessageEvent) => {
      if (!fromClient(event)) return
      const msg = event.data as HostToFrame
      if (!msg || typeof msg !== 'object' || msg.hp !== PROTOCOL_VERSION || typeof msg.t !== 'string') return
      if (!room) {
        if (msg.t !== 'init') return
        room = new RoomImpl(event.origin)
        room.receive(msg)
        clearTimeout(timer)
        resolve(room)
        return
      }
      room.receive(msg)
    })
    window.parent.postMessage({ hp: PROTOCOL_VERSION, t: 'ready', sdk: SDK_VERSION } satisfies FrameToHost, '*')
  })
  return pending
}
