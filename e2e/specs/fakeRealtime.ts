// Scripted Realtime server for journeys: the e2e stack runs no Realtime. page.routeWebSocket takes
// the page's Realtime socket before the network, so the gateway's 501 on that path never applies.
//
// Phoenix frames: vsn 1.0.0 objects {topic, event, payload, ref, join_ref}, vsn 2.0.0 JSON arrays
// [join_ref, ref, topic, event, payload]. Every join, leave and heartbeat is answered ok; presence
// and postgres_changes get no state.

import type { Page, WebSocketRoute } from '@playwright/test'

interface Frame {
  topic: string
  event: string
  payload: any
  ref: string | null
  join_ref: string | null
}

export interface Join {
  topic: string
  ref: string
  at: number
  socket: number
}

export class FakeRealtime {
  private sockets: Array<{ ws: WebSocketRoute; array: boolean }> = []
  readonly joins: Join[] = []
  /** Topic to its newest join on the newest socket. */
  readonly joined = new Map<string, Join>()

  static async attach(page: Page): Promise<FakeRealtime> {
    const fake = new FakeRealtime()
    await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => fake.accept(ws))
    return fake
  }

  get socketCount(): number {
    return this.sockets.length
  }

  private accept(ws: WebSocketRoute): void {
    const socket = { ws, array: false }
    const index = this.sockets.push(socket) - 1
    this.joined.clear()
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return
      const parsed = JSON.parse(raw)
      socket.array = Array.isArray(parsed)
      const frame: Frame = socket.array
        ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] }
        : parsed
      if (frame.event === 'phx_join') {
        const join = { topic: frame.topic, ref: String(frame.ref), at: Date.now(), socket: index }
        this.joins.push(join)
        this.joined.set(frame.topic, join)
      } else if (frame.event === 'phx_leave') {
        this.joined.delete(frame.topic)
      }
      if (['phx_join', 'phx_leave', 'heartbeat'].includes(frame.event)) {
        this.send(index, { topic: frame.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: frame.ref, join_ref: frame.join_ref })
      }
    })
  }

  private send(index: number, frame: Frame): void {
    const { ws, array } = this.sockets[index]
    ws.send(JSON.stringify(array ? [frame.join_ref, frame.ref, frame.topic, frame.event, frame.payload] : frame))
  }

  /** The frame Realtime sends when it stops a channel process: events limit, expired token. */
  closeChannel(topic: string): void {
    const join = this.joined.get(topic)
    if (!join) throw new Error(`${topic} is not joined`)
    this.joined.delete(topic)
    this.send(join.socket, { topic, event: 'phx_close', payload: {}, ref: join.ref, join_ref: join.ref })
  }

  broadcast(topic: string, event: string, payload: Record<string, unknown>): void {
    const join = this.joined.get(topic)
    if (!join) throw new Error(`${topic} is not joined`)
    this.send(join.socket, { topic, event: 'broadcast', payload: { type: 'broadcast', event, payload }, ref: null, join_ref: join.ref })
  }

  joinsOf(topic: string): Join[] {
    return this.joins.filter((j) => j.topic === topic)
  }
}
