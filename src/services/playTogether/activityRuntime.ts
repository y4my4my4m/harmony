import { RelayConnection, type FinalReason } from './relayConnection'
import type { ActivitySession } from './sessions'
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
  type FrameToHost,
  type HostToFrame,
  type Json,
  type MemberInfo,
  type RelayFrame,
  type SessionInfo,
  type ThemeInfo,
  type WireMember,
} from '../../../activities/sdk/protocol'

/**
 * One joined session: the relay connection and the bridge to the activity frame.
 *
 * Frame messages are accepted only from the frame's own window, checked against the protocol's
 * shapes and sizes and rate-limited before they reach the relay; the frame never sees the token.
 * Relay frames reach the frame in order through one promise chain, each member with its avatar as a
 * Blob (the frame's CSP refuses remote images). The runtime mirrors members, host, state and, while
 * this client hosts, the store, so a reloaded frame gets the full picture again with `init`.
 *
 * Nothing is posted to a frame before it reports `ready`. When the frame's document is left (the
 * loader's `gone`, or a load the host did not start), the runtime detaches for good: whatever
 * document the activity navigated to receives nothing further and is not heard.
 */

export type RuntimeStatus = 'connecting' | ConnectionStatus | 'ended' | 'failed'

export interface RuntimeView {
  status: RuntimeStatus
  members: MemberInfo[]
  hostId: string | null
  you: string | null
  canEnd: boolean
  final: FinalReason | null
  frameReady: boolean
  /** The frame left its document; the bridge no longer talks to it. */
  escaped: boolean
}

export interface RuntimeOptions {
  locale(): string
  theme(): ThemeInfo
  visible(): boolean
  /** The activity asked for attention. */
  notify(text: string): void
  /** The activity asked to close itself for this account. */
  leave(): void
  save(blob: Blob, name: string): Promise<boolean>
}

const AVATAR_TIMEOUT_MS = 2_500
const AVATAR_CACHE_SIZE = 64
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
const FRAME_RATE_PER_SECOND = 60
const FRAME_RATE_BURST = 120
/** Image saves need the frame focused (the click that asked for one), and are spaced and counted. */
export const SAVE_INTERVAL_MS = 2_000
export const SAVE_MAX_PER_SESSION = 20
const MAX_TARGETS = 64

/** Insertion-ordered: a hit moves to the end, the first entry is the least recently used. */
const avatarCache = new Map<string, Promise<Blob | null>>()

const IMAGE_SIGNATURES: Record<string, { ext: string; test: (b: Uint8Array) => boolean }> = {
  'image/png': { ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  'image/webp': { ext: 'webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
}

/**
 * `blob` when its bytes begin as its declared image type says, with a file name whose extension is
 * that type's; null otherwise. The activity chooses neither the format nor the extension.
 */
export async function checkedImage(blob: Blob, name: string): Promise<{ blob: Blob; name: string } | null> {
  const signature = IMAGE_SIGNATURES[blob.type]
  if (!signature || blob.size > SAVE_MAX_BYTES) return null
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  if (head.length < 12 || !signature.test(head)) return null
  const base = String(name || 'activity')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/^[.\s]+/, '')
    .slice(0, 100) || 'activity'
  return { blob, name: `${base}.${signature.ext}` }
}

/** The image at `url` as a Blob, or null on failure, timeout or more than AVATAR_MAX_BYTES. */
export function avatarBlob(url: string | null): Promise<Blob | null> {
  if (!url || !/^(https?:|\/)/i.test(url)) return Promise.resolve(null)
  let pending = avatarCache.get(url)
  if (pending) {
    avatarCache.delete(url)
    avatarCache.set(url, pending)
  } else {
    pending = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS)
      try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit' })
        if (!response.ok) return null
        const blob = await response.blob()
        return blob.size <= AVATAR_MAX_BYTES && blob.type.startsWith('image/') ? blob : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    })()
    avatarCache.set(url, pending)
    if (avatarCache.size > AVATAR_CACHE_SIZE) avatarCache.delete(avatarCache.keys().next().value!)
    pending.then((blob) => { if (!blob) avatarCache.delete(url) }).catch(() => {})
  }
  return pending
}

function isTarget(value: unknown): value is 'host' | string[] {
  return value === 'host' || (Array.isArray(value) && value.length <= MAX_TARGETS && value.every((v) => typeof v === 'string'))
}

export class ActivityRuntime {
  private connection: RelayConnection
  private frame: HTMLIFrameElement | null = null
  private frameInitialized = false
  private session: SessionInfo | null = null
  private state: Json = null
  private store = new Map<string, Json>()
  private members = new Map<string, MemberInfo>()
  private clockOffset = 0
  private welcomed = false
  private chain: Promise<void> = Promise.resolve()
  private tokens = FRAME_RATE_BURST
  private tokensAt = Date.now()
  private saves = 0
  private lastSaveAt = -Infinity
  private readonly onWindowMessage = (event: MessageEvent) => this.fromFrame(event)

  constructor(
    readonly activitySession: ActivitySession,
    private readonly avatarUrl: (member: MemberInfo) => string | null,
    readonly view: RuntimeView,
    private readonly options: RuntimeOptions,
  ) {
    this.connection = new RelayConnection(activitySession.id, {
      frame: (frame) => this.fromRelay(frame),
      status: (status) => {
        if (this.view.status !== 'ended' && this.view.status !== 'failed') this.view.status = status
        this.post({ hp: PROTOCOL_VERSION, t: 'connection', status })
      },
      clock: (offset) => {
        const moved = Math.abs(offset - this.clockOffset) > 25
        this.clockOffset = offset
        if (moved) this.post({ hp: PROTOCOL_VERSION, t: 'clock', clockOffset: offset })
      },
      final: (reason) => {
        this.view.final = reason
        this.view.status = reason.kind === 'ended' ? 'ended' : 'failed'
      },
    })
  }

  start(): void {
    window.addEventListener('message', this.onWindowMessage)
    this.connection.start()
  }

  destroy(): void {
    window.removeEventListener('message', this.onWindowMessage)
    this.connection.stop()
    this.frame = null
  }

  /** The frame element now showing the activity; a new element or a reload starts it over. */
  attachFrame(frame: HTMLIFrameElement | null): void {
    if (frame !== this.frame) {
      this.frame = frame
      this.frameInitialized = false
      this.view.frameReady = false
    }
  }

  /** The frame started over (its document loaded again). */
  frameReloaded(): void {
    this.frameInitialized = false
    this.view.frameReady = false
  }

  /** The frame left the document the client gave it: stop talking to it. */
  escape(): void {
    this.frame = null
    this.frameInitialized = false
    this.view.frameReady = false
    this.view.escaped = true
  }

  setVisible(visible: boolean): void {
    this.post({ hp: PROTOCOL_VERSION, t: 'visibility', visible })
  }

  pushTheme(theme: ThemeInfo): void {
    this.post({ hp: PROTOCOL_VERSION, t: 'theme', theme })
  }

  end(): void {
    this.connection.send({ op: 'end' })
  }

  /* -------------------------------------------------------------------------------------------- */

  private fromRelay(frame: RelayFrame): void {
    switch (frame.op) {
      case 'welcome': {
        const again = this.welcomed
        this.welcomed = true
        this.session = frame.session
        this.view.you = frame.you.id
        this.view.canEnd = frame.canEnd
        this.members = new Map(frame.members.map((m) => [m.id, m]))
        this.state = frame.state
        this.store = new Map(Object.entries(frame.store ?? {}))
        this.view.hostId = frame.host
        this.syncMembers()
        if (this.frameInitialized && again) this.enqueue(() => this.resync())
        else if (this.frame && this.view.frameReady) this.enqueue(() => this.init())
        return
      }
      case 'join':
        this.members.set(frame.member.id, frame.member)
        this.syncMembers()
        this.enqueue(async () => this.post({ hp: PROTOCOL_VERSION, t: 'join', member: await this.wire(frame.member) }))
        return
      case 'leave':
        this.members.delete(frame.id)
        this.syncMembers()
        this.enqueue(() => this.post({ hp: PROTOCOL_VERSION, t: 'leave', id: frame.id, reason: frame.reason }))
        return
      case 'host':
        this.view.hostId = frame.id
        this.store = new Map(Object.entries(frame.store ?? {}))
        this.enqueue(() => this.post({ hp: PROTOCOL_VERSION, t: 'host', id: frame.id, ...(frame.store ? { store: frame.store } : {}) }))
        return
      case 'message':
        this.enqueue(() => this.post({ hp: PROTOCOL_VERSION, t: 'message', from: frame.from, data: frame.data }))
        return
      case 'state':
        this.state = frame.state
        this.enqueue(() => this.post({ hp: PROTOCOL_VERSION, t: 'state', state: frame.state, from: frame.from }))
        return
      case 'member': {
        const member = this.members.get(frame.id)
        if (member) member.state = frame.state
        this.enqueue(() => this.post({ hp: PROTOCOL_VERSION, t: 'member', id: frame.id, state: frame.state }))
        return
      }
      case 'ended':
        this.enqueue(() => this.post({ hp: PROTOCOL_VERSION, t: 'ended', reason: frame.reason }))
        return
      case 'error':
        if (!frame.fatal) this.enqueue(() => this.post({ hp: PROTOCOL_VERSION, t: 'error', code: frame.code, message: frame.message }))
        return
      case 'pong':
        return
    }
  }

  private fromFrame(event: MessageEvent): void {
    if (!this.frame || event.source !== this.frame.contentWindow) return
    const msg = event.data as FrameToHost
    if (!msg || typeof msg !== 'object' || msg.hp !== PROTOCOL_VERSION || typeof msg.t !== 'string') return
    if (msg.t === 'gone') return this.escape()
    if (!this.take()) {
      this.post({ hp: PROTOCOL_VERSION, t: 'error', code: 'RATE_LIMITED' })
      return
    }
    const me = this.view.you
    const hosting = !!me && this.view.hostId === me

    switch (msg.t) {
      case 'ready':
        this.view.frameReady = true
        this.frameInitialized = false
        if (this.welcomed) this.enqueue(() => this.init())
        return
      case 'send':
        if (msg.to !== undefined && !isTarget(msg.to)) return
        if (jsonBytes(msg.data) > MESSAGE_MAX_BYTES) return this.refuse('TOO_LARGE')
        this.connection.send({ op: 'send', data: msg.data, ...(msg.to !== undefined ? { to: msg.to } : {}) })
        return
      case 'state':
        if (!hosting) return this.refuse('NOT_HOST')
        if (jsonBytes(msg.state) > STATE_MAX_BYTES) return this.refuse('TOO_LARGE')
        this.state = msg.state
        this.connection.send({ op: 'state', state: msg.state })
        return
      case 'store': {
        if (!hosting) return this.refuse('NOT_HOST')
        if (typeof msg.key !== 'string' || !msg.key || msg.key.length > STORE_KEY_MAX_LENGTH) return
        if (msg.value === undefined) {
          this.store.delete(msg.key)
          this.connection.send({ op: 'store', key: msg.key })
          return
        }
        if (jsonBytes(msg.value) > STORE_VALUE_MAX_BYTES) return this.refuse('TOO_LARGE')
        this.store.set(msg.key, msg.value)
        this.connection.send({ op: 'store', key: msg.key, value: msg.value })
        return
      }
      case 'me': {
        if (jsonBytes(msg.state) > MEMBER_STATE_MAX_BYTES) return this.refuse('TOO_LARGE')
        const member = me ? this.members.get(me) : undefined
        if (member) member.state = msg.state
        this.connection.send({ op: 'me', state: msg.state })
        return
      }
      case 'end':
        this.connection.send({ op: 'end' })
        return
      case 'leave':
        this.options.leave()
        return
      case 'notify':
        if (typeof msg.text === 'string') this.options.notify(msg.text.slice(0, 140))
        return
      case 'save': {
        const id = Number(msg.id)
        const blob = msg.blob
        const now = Date.now()
        if (
          !(blob instanceof Blob)
          || !(SAVE_TYPES as readonly string[]).includes(blob.type)
          || document.activeElement !== this.frame
          || this.saves >= SAVE_MAX_PER_SESSION
          || now - this.lastSaveAt < SAVE_INTERVAL_MS
        ) {
          this.post({ hp: PROTOCOL_VERSION, t: 'saved', id, ok: false })
          return
        }
        this.saves += 1
        this.lastSaveAt = now
        checkedImage(blob, String(msg.name ?? ''))
          .then((image) => (image ? this.options.save(image.blob, image.name) : false))
          .then((ok) => this.post({ hp: PROTOCOL_VERSION, t: 'saved', id, ok }))
          .catch(() => this.post({ hp: PROTOCOL_VERSION, t: 'saved', id, ok: false }))
        return
      }
    }
  }

  private async init(): Promise<void> {
    if (!this.session || !this.view.you || !this.view.hostId) return
    const members = await Promise.all([...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => this.wire(m)))
    const hosting = this.view.hostId === this.view.you
    this.post({
      hp: PROTOCOL_VERSION,
      t: 'init',
      session: this.session,
      you: this.view.you,
      members,
      host: this.view.hostId,
      state: this.state,
      ...(hosting ? { store: Object.fromEntries(this.store) } : {}),
      canEnd: this.view.canEnd,
      clockOffset: this.clockOffset,
      locale: this.options.locale(),
      theme: this.options.theme(),
      visible: this.options.visible(),
    })
    this.frameInitialized = true
  }

  private async resync(): Promise<void> {
    if (!this.view.hostId) return
    const members = await Promise.all([...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => this.wire(m)))
    const hosting = this.view.hostId === this.view.you
    this.post({
      hp: PROTOCOL_VERSION,
      t: 'resync',
      members,
      host: this.view.hostId,
      state: this.state,
      ...(hosting ? { store: Object.fromEntries(this.store) } : {}),
      clockOffset: this.clockOffset,
    })
  }

  private async wire(member: MemberInfo): Promise<WireMember> {
    return { ...member, avatarBlob: await avatarBlob(this.avatarUrl(member)) }
  }

  private syncMembers(): void {
    this.view.members = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({ ...m }))
  }

  private enqueue(task: () => void | Promise<void>): void {
    this.chain = this.chain.then(task).catch(() => {})
  }

  private refuse(code: 'TOO_LARGE' | 'NOT_HOST'): void {
    this.post({ hp: PROTOCOL_VERSION, t: 'error', code })
  }

  private take(): boolean {
    const now = Date.now()
    this.tokens = Math.min(FRAME_RATE_BURST, this.tokens + ((now - this.tokensAt) / 1000) * FRAME_RATE_PER_SECOND)
    this.tokensAt = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }

  private post(msg: HostToFrame): void {
    const target = this.frame?.contentWindow
    if (!target || !this.view.frameReady) return
    // The frame's origin is opaque ('null'): '*' is the only target that reaches it; the window
    // reference above is what selects the recipient.
    target.postMessage(msg, '*')
  }
}
