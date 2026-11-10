import { timingSafeEqual, createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { z } from 'zod'
import type { MatrixEvent } from './Relay.js'

const transactionSchema = z.object({ events: z.array(z.object({
  type: z.string().max(255),
  event_id: z.string().max(255).optional(),
  room_id: z.string().max(255).optional(),
  sender: z.string().max(255).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
}).passthrough()).max(1000) })
const MAX_BODY = 1024 * 1024

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 })
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}

export interface AppServiceOptions {
  hsToken: string
  botUserId: string
  ownsGhost?: (id: string) => boolean
  acceptTransaction: (id: string, events: MatrixEvent[]) => boolean
  status: () => { ready: boolean; pending: number; failed: number }
}

/** Authenticate before parsing; acknowledge a transaction only after durable acceptance. */
export function createAppService(options: AppServiceOptions): Server {
  const expected = createHash('sha256').update(`Bearer ${options.hsToken}`).digest()
  const server = createServer(async (req, res) => {
    const respond = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        const status = options.status()
        respond(status.ready ? 200 : 503, status)
        return
      }
      const actual = createHash('sha256').update(req.headers.authorization ?? '').digest()
      if (!timingSafeEqual(expected, actual)) {
        respond(401, { errcode: 'M_UNAUTHORIZED', error: 'Invalid application-service authentication' })
        return
      }
      const match = /^\/_matrix\/app\/v1\/transactions\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'PUT' && match) {
        let id: string
        try { id = decodeURIComponent(match[1]) } catch { respond(400, { error: 'Invalid transaction ID' }); return }
        if (!id || id.length > 255) { respond(400, { error: 'Invalid transaction ID' }); return }
        const parsed = transactionSchema.safeParse(await body(req))
        if (!parsed.success) { respond(400, { errcode: 'M_BAD_JSON', error: 'Invalid transaction' }); return }
        options.acceptTransaction(id, parsed.data.events)
        respond(200, {})
        return
      }
      const user = /^\/_matrix\/app\/v1\/users\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && user && (decodeURIComponent(user[1]) === options.botUserId || options.ownsGhost?.(decodeURIComponent(user[1])))) {
        respond(200, {})
        return
      }
      if (req.method === 'POST' && url.pathname === '/_matrix/app/v1/ping') {
        await body(req)
        respond(200, {})
        return
      }
      respond(404, { errcode: 'M_NOT_FOUND', error: 'Not found' })
    } catch (error) {
      const status = (error as { status?: number }).status
      respond(status === 400 || status === 413 ? status : 503, { error: 'Transaction not accepted' })
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.timeout = 15_000
  server.maxRequestsPerSocket = 100
  return server
}
