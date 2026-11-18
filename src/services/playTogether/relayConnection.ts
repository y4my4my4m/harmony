import { supabase } from '@/supabase'
import { activityRelayUrl } from './catalog'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ConnectionStatus,
  type RelayFrame,
} from '../../../activities/sdk/protocol'

/**
 * The client's socket to the instance relay (federation-backend src/activities/relay.ts) for one
 * session. Reconnects with backoff after a drop; refusals, a replacement by another tab and the
 * session's end are final. Sends the refreshed access token as `auth` so the relay keeps the socket
 * past the token's expiry. Measures the relay clock from pings: offset = serverTime minus the local
 * midpoint of the round trip with the shortest round trip of the last PING_SAMPLES.
 */

const PING_MS = 15_000
const PING_SAMPLES = 8
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

/** Close codes after which the connection is not retried (protocol.ts CLOSE). */
const FINAL_CODES = new Set([4001, 4002, 4003, 4005, 4009])

export type FinalReason =
  | { kind: 'refused'; refusal: string }
  | { kind: 'unauthorized' }
  | { kind: 'replaced' }
  | { kind: 'ended'; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'closed' }

export interface RelayHandlers {
  frame(frame: RelayFrame): void
  status(status: ConnectionStatus): void
  clock(offset: number): void
  final(reason: FinalReason): void
}

export class RelayConnection {
  private ws: WebSocket | null = null
  private attempt = 0
  private stopped = false
  private welcomed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private samples: Array<{ rtt: number; offset: number }> = []
  private unsubscribeAuth: (() => void) | null = null
  private lastFinal: FinalReason | null = null

  constructor(private readonly sessionId: string, private readonly handlers: RelayHandlers) {}

  start(): void {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        this.finish({ kind: 'closed' })
        const ws = this.ws
        this.ws = null
        ws?.close(1000, 'signed out')
        return
      }
      if (event === 'TOKEN_REFRESHED' && session?.access_token && this.welcomed) {
        this.send({ op: 'auth', token: session.access_token })
      }
    })
    this.unsubscribeAuth = () => data.subscription.unsubscribe()
    void this.open()
  }

  /** Sends when connected; frames sent while reconnecting are dropped. */
  send(frame: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || (!this.welcomed && frame.op !== 'hello')) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  stop(): void {
    this.stopped = true
    this.cleanupTimers()
    this.unsubscribeAuth?.()
    this.unsubscribeAuth = null
    const ws = this.ws
    this.ws = null
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000, 'left')
  }

  private async open(): Promise<void> {
    if (this.stopped) return
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (this.stopped) return
    if (!token) return this.finish({ kind: 'unauthorized' })

    let ws: WebSocket
    try {
      ws = new WebSocket(activityRelayUrl())
    } catch (error) {
      return this.finish({ kind: 'error', message: (error as Error).message })
    }
    this.ws = ws
    this.welcomed = false

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'hello', v: PROTOCOL_VERSION, token, session: this.sessionId } satisfies ClientFrame))
    }
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let frame: RelayFrame
      try {
        frame = JSON.parse(event.data) as RelayFrame
      } catch {
        return
      }
      this.onFrame(frame)
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = null
      this.welcomed = false
      this.cleanupTimers()
      if (this.stopped) return
      if (FINAL_CODES.has(event.code)) {
        return this.finish(this.lastFinal ?? (event.code === 4009 ? { kind: 'replaced' } : event.code === 4001 ? { kind: 'unauthorized' } : { kind: 'closed' }))
      }
      this.handlers.status(this.attempt === 0 ? 'reconnecting' : 'offline')
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
      this.attempt++
      this.retryTimer = setTimeout(() => void this.open(), delay)
    }
  }

  private onFrame(frame: RelayFrame): void {
    switch (frame.op) {
      case 'welcome':
        this.welcomed = true
        this.attempt = 0
        this.samples = []
        this.recordClock(frame.serverTime, 0, Date.now())
        this.handlers.status('connected')
        this.pingTimer = setInterval(() => this.send({ op: 'ping', t: Date.now() }), PING_MS)
        this.send({ op: 'ping', t: Date.now() })
        break
      case 'pong': {
        const now = Date.now()
        this.recordClock(frame.serverTime, now - frame.t, now)
        return
      }
      case 'error':
        if (frame.fatal) {
          if (frame.code === 'REFUSED') this.lastFinal = { kind: 'refused', refusal: frame.refusal ?? 'NOT_FOUND' }
          else if (frame.code === 'UNAUTHORIZED') this.lastFinal = { kind: 'unauthorized' }
          else if (frame.code === 'REPLACED') this.lastFinal = { kind: 'replaced' }
          else this.lastFinal = { kind: 'error', message: frame.message ?? frame.code }
        }
        break
      case 'ended':
        this.lastFinal = { kind: 'ended', reason: frame.reason }
        break
    }
    this.handlers.frame(frame)
  }

  private recordClock(serverTime: number, rtt: number, receivedAt: number): void {
    const offset = serverTime - (receivedAt - rtt / 2)
    this.samples.push({ rtt, offset })
    if (this.samples.length > PING_SAMPLES) this.samples.shift()
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt || (a.rtt === 0 && b.rtt > 0) ? b : a))
    this.handlers.clock(best.offset)
  }

  private cleanupTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.retryTimer = null
    this.pingTimer = null
  }

  private finish(reason: FinalReason): void {
    if (this.stopped) return
    this.stopped = true
    this.cleanupTimers()
    this.unsubscribeAuth?.()
    this.unsubscribeAuth = null
    this.handlers.final(reason)
  }
}
