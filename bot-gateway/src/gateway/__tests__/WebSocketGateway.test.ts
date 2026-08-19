import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { createHash } from 'crypto'
import type { AddressInfo } from 'net'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const TOKEN = 'hrm_bot_9f2c1d4e8a7b'
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex')

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  config: {
    supabaseUrl: 'http://localhost:54321',
    port: 3002,
    nodeEnv: 'test',
    instanceDomain: 'harmony.test',
    websocket: { heartbeatInterval: 30_000, maxConnectionsPerBot: 5 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: mocks.config,
}))

import { WebSocketGateway } from '../WebSocketGateway.js'

const VALID_VERIFICATION = {
  valid: true,
  bot_id: BOT_ID,
  username: 'testbot',
  scopes: ['bot'],
}

/**
 * Every builder method chains and resolves empty. Presence writes end in a bare
 * `.then()` with no callback, so the thenable has to tolerate that.
 */
function stubTables() {
  const settle = (resolve?: (r: unknown) => unknown) => {
    const result = { data: null, error: null }
    return typeof resolve === 'function' ? resolve(result) : Promise.resolve(result)
  }
  mocks.from.mockImplementation(() => {
    const builder: any = new Proxy(
      { then: settle },
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop]
          return () => builder
        },
      },
    )
    return builder
  })
}

let wss: WebSocketServer
let gateway: WebSocketGateway
let url: string
const sockets: WebSocket[] = []

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(url)
  sockets.push(ws)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Next frame, or the close code if the socket closes first. */
function nextEvent(ws: WebSocket, timeoutMs = 2000): Promise<{ frame?: any; close?: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no frame and no close within ${timeoutMs}ms`)),
      timeoutMs,
    )
    ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve({ frame: JSON.parse(raw.toString()) })
    })
    ws.once('close', (code) => {
      clearTimeout(timer)
      resolve({ close: code })
    })
  })
}

async function identify(token?: string) {
  const ws = await connect()
  ws.send(JSON.stringify({ op: 2, d: token === undefined ? {} : { token } }))
  return { ws, event: await nextEvent(ws) }
}

beforeEach(async () => {
  mocks.rpc.mockReset()
  stubTables()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  wss = new WebSocketServer({ port: 0, path: '/gateway' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  gateway = new WebSocketGateway(wss)
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/gateway`
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  gateway.shutdown()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  vi.restoreAllMocks()
})

describe('gateway IDENTIFY', () => {
  it('closes 4001 when the payload carries no token', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    const { event } = await identify()

    expect(event.close).toBe(4001)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('closes 4004 on a token the RPC rejects', async () => {
    mocks.rpc.mockResolvedValue({ data: { valid: false }, error: null })
    const { event } = await identify(TOKEN)

    expect(event.close).toBe(4004)
  })

  it('answers READY with the bot identity, a session id and the heartbeat interval', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    const { event } = await identify(TOKEN)

    expect(mocks.rpc).toHaveBeenCalledWith('verify_bot_token', { p_token_hash: TOKEN_SHA256 })
    expect(event.frame).toMatchObject({
      op: 0,
      t: 'READY',
      d: {
        bot: { id: BOT_ID, username: 'testbot' },
        heartbeat_interval: 30_000,
      },
    })
    expect(event.frame.d.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(gateway.getConnectedBotCount()).toBe(1)
  })

  // WebSocketGateway.ts:131 does not destructure `error`, so an RPC failure reaches
  // the same branch as a rejected token. Fail-closed is correct; the log line reads
  // "Invalid bot token attempt" either way.
  it('refuses the connection when the RPC fails', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42703', message: 'column "is_active" does not exist' },
    })
    const { event } = await identify(TOKEN)

    expect(event.close).toBe(4004)
    expect(gateway.getConnectedBotCount()).toBe(0)
  })
})

describe('gateway frames', () => {
  it('acknowledges a heartbeat with op 11', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    const { ws } = await identify(TOKEN)

    ws.send(JSON.stringify({ op: 1 }))
    const event = await nextEvent(ws)

    expect(event.frame).toEqual({ op: 11 })
  })

  it('ignores a heartbeat from an unidentified socket', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ op: 1 }))

    await expect(nextEvent(ws, 300)).rejects.toThrow(/no frame and no close/)
  })

  it('closes 1008 on an unparseable payload', async () => {
    const ws = await connect()
    ws.send('not json')
    const event = await nextEvent(ws)

    expect(event.close).toBe(1008)
  })

  it('drops the bot from the connected set when the socket closes', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    const { ws } = await identify(TOKEN)
    expect(gateway.getConnectedBotCount()).toBe(1)

    ws.close()
    await vi.waitFor(() => expect(gateway.getConnectedBotCount()).toBe(0))
  })
})
