import { Router, type Request, type Response, type RequestHandler } from 'express'
import { supabase } from '../config/supabase.js'
import type { BotRequest } from '../auth/BotAuthMiddleware.js'
import { prepareBotMessageContent } from '../api/messageContent.js'
import { importBlock, type BridgeRow } from './bridgeConfig.js'
import { discardMirroredParts, enqueueMirror } from './mirrorEnqueue.js'

/**
 * Bridge v2 history import endpoints, mounted under /bridge/v2/imports behind the bridgeBot
 * middleware (bot token, rate limit, req.bridge). Thin over the discord_bridge_import_* and
 * bridge_import_* RPCs; errors keep the RPC contract (the exception message is the code).
 *
 * Every route answers 403 import_disabled while discord_bridge_import_block() names a reason:
 * the instance switch is off, or the bridge is hosted or the instance bot.
 */

type ImportRequest = BotRequest & { bridge?: BridgeRow }
type RpcError = { code?: string; message?: string; details?: string | null }
type ErrorKind = 'patch' | 'batch' | 'thread' | 'generic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNOWFLAKE_RE = /^[0-9]{1,20}$/
const MAX_BATCH = 100
// A created_at or edited_at further ahead of this clock is refused (bridge_import_messages applies
// the same margin against the database clock).
const FUTURE_MARGIN_MS = 60_000
// Seconds a bridge waits when the instance runs its maximum number of imports.
const BUSY_RETRY_SECONDS = 30
// Messages whose attachments are prepared (and possibly mirrored) at once.
const PREPARE_CONCURRENCY = 5

// Postgres cast, range and check failures from values the bridge sent.
const BAD_VALUE_SQLSTATES = new Set(['22007', '22P02', '22003', '22023', '23514'])
const BAD_VALUE_CODE: Record<ErrorKind, string> = {
  patch: 'invalid_patch',
  batch: 'invalid_batch',
  thread: 'invalid_thread',
  generic: 'invalid_request',
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isDate = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value))

const notRunning = (res: Response) => res.status(409).json({ code: 'import_not_running' })

/** 429 with the wait in the Retry-After header and in the body. */
function retryLater(res: Response, code: string, seconds: number) {
  const wait = Math.max(1, Math.ceil(seconds))
  res.set('Retry-After', String(wait)).status(429).json({ code, retry_after: wait })
}

/** Imported text pings nobody: user and role mentions become their text. */
export function withoutMentions(parts: unknown[]): unknown[] {
  return parts.map((part) => {
    if (!isObject(part)) return part
    if (part.type === 'mention') {
      const name = [part.displayName, part.username].find((v) => typeof v === 'string' && v.trim() !== '')
      return { type: 'text', text: `@${typeof name === 'string' ? name : 'user'}` }
    }
    if (part.type === 'role_mention') {
      const name = typeof part.roleName === 'string' && part.roleName.trim() !== '' ? part.roleName : 'role'
      return { type: 'text', text: `@${name.replace(/^@/, '')}` }
    }
    return part
  })
}

/** Answers an RPC error; false when `error` is empty. */
function sendRpcError(res: Response, error: RpcError | null | undefined, rpc: string, kind: ErrorKind): boolean {
  if (!error) return false
  const message = error.message ?? ''
  if (message === 'import_not_found' || error.code === 'P0002') {
    res.status(404).json({ code: 'import_not_found' })
  } else if (message === 'import_not_running') {
    notRunning(res)
  } else if (message === 'invalid_transition') {
    res.status(409).json({ code: 'invalid_transition' })
  } else if (message === 'import_disabled') {
    res.status(403).json({ code: 'import_disabled', reason: error.details ?? null })
  } else if (message === 'import_busy') {
    retryLater(res, 'import_busy', Number(error.details) || BUSY_RETRY_SECONDS)
  } else if (message === 'pair_not_importable') {
    res.status(400).json({ code: 'pair_not_importable', discord_channel_id: error.details ?? null })
  } else if (error.code !== undefined && BAD_VALUE_SQLSTATES.has(error.code)) {
    res.status(400).json({ code: BAD_VALUE_CODE[kind] })
  } else {
    console.error(`${rpc} failed:`, error.code, message)
    res.status(500).json({ error: 'Import request failed' })
  }
  return true
}

interface PreparedInput {
  discord_message_id: string
  content: unknown[]
  rest: Record<string, unknown>
}

/** The Discord id of a batch entry, when it has a usable one. */
function messageId(raw: unknown): string | null {
  const id = isObject(raw) ? raw.discord_message_id : null
  return typeof id === 'string' && SNOWFLAKE_RE.test(id) ? id : null
}

const isFuture = (value: unknown, now: number): boolean =>
  typeof value === 'string' && Date.parse(value) > now + FUTURE_MARGIN_MS

/** The message as the RPC takes it (minus content), or null when a field has the wrong type. */
function validateMessage(raw: unknown): PreparedInput | null {
  if (!isObject(raw)) return null
  const { discord_message_id: id, created_at, edited_at, content, discord_user, reply_to_discord_message_id, thread_id, pinned } = raw
  if (typeof id !== 'string' || !SNOWFLAKE_RE.test(id)) return null
  if (!isDate(created_at)) return null
  if (edited_at != null && !isDate(edited_at)) return null
  if (!Array.isArray(content)) return null
  if (discord_user != null && !isObject(discord_user)) return null
  if (reply_to_discord_message_id != null
    && (typeof reply_to_discord_message_id !== 'string' || !SNOWFLAKE_RE.test(reply_to_discord_message_id))) return null
  if (thread_id != null && (typeof thread_id !== 'string' || !UUID_RE.test(thread_id))) return null
  if (pinned != null && typeof pinned !== 'boolean') return null
  const rest: Record<string, unknown> = { discord_message_id: id, created_at }
  if (edited_at != null) rest.edited_at = edited_at
  if (discord_user != null) rest.discord_user = discord_user
  if (reply_to_discord_message_id != null) rest.reply_to_discord_message_id = reply_to_discord_message_id
  if (thread_id != null) rest.thread_id = thread_id
  if (pinned != null) rest.pinned = pinned
  return { discord_message_id: id, content, rest }
}

/**
 * `guard` is the bridge-bot middleware (auth, rate limit, bridge lookup). It goes on each route,
 * not on the mount: the rate limiter buckets by `req.route`, which Express sets only inside a
 * route, so mounted once every import call would share a single bucket.
 */
export function createHistoryImportRouter(guard: RequestHandler[] = []): Router {
  const router = Router()

  // A job id that is not a UUID is no job of this bridge.
  router.param('id', (_req, res, next, id) => {
    if (!UUID_RE.test(String(id))) return res.status(404).json({ code: 'import_not_found' })
    next()
  })

  const bridgeId = (req: Request) => (req as ImportRequest).bridge!.id
  const botId = (req: Request) => (req as ImportRequest).bot!.id

  // After `guard`, which sets req.bridge.
  const allowed: RequestHandler = async (req, res, next) => {
    let block: Awaited<ReturnType<typeof importBlock>>
    try {
      block = await importBlock(bridgeId(req))
    } catch (error) {
      console.error('discord_bridge_import_block threw:', error)
      block = 'error'
    }
    if (block === 'error') return res.status(503).json({ error: 'Import state unavailable' })
    if (block) return res.status(403).json({ code: 'import_disabled', reason: block })
    next()
  }
  const open = [...guard, allowed]

  const handler = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    async (req, res) => {
      try {
        await fn(req, res)
      } catch (error) {
        console.error('history import request failed:', error)
        if (!res.headersSent) res.status(500).json({ error: 'Import request failed' })
      }
    }

  router.get('/', ...open, handler(async (req, res) => {
    const { data, error } = await supabase
      .from('discord_bridge_imports')
      .select('*')
      .eq('bridge_id', bridgeId(req))
      .order('created_at', { ascending: true })
    if (error) {
      console.error('discord_bridge_imports select failed:', error.code, error.message)
      return res.status(500).json({ error: 'Import request failed' })
    }
    res.json({ imports: data ?? [] })
  }))

  router.get('/:id', ...open, handler(async (req, res) => {
    const { data, error } = await supabase
      .from('discord_bridge_imports')
      .select('*')
      .eq('id', req.params.id)
      .eq('bridge_id', bridgeId(req))
      .maybeSingle()
    if (error) {
      console.error('discord_bridge_imports select failed:', error.code, error.message)
      return res.status(500).json({ error: 'Import request failed' })
    }
    if (!data) return res.status(404).json({ code: 'import_not_found' })
    res.json({ import: data })
  }))

  router.post('/', ...open, handler(async (req, res) => {
    const body = (req.body ?? {}) as { discord_channel_ids?: unknown; requested_by?: unknown }
    const ids = body.discord_channel_ids
    if (ids != null && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && SNOWFLAKE_RE.test(id)))) {
      return res.status(400).json({ code: 'invalid_request', error: 'discord_channel_ids must be an array of Discord ids' })
    }
    // The Discord member who ran the command; the function keeps id and username.
    const requester = isObject(body.requested_by) ? body.requested_by : null
    const { data, error } = await supabase.rpc('discord_bridge_import_start_internal', {
      p_bridge_id: bridgeId(req),
      p_discord_channel_ids: ids ?? null,
      p_via: 'discord',
      p_requested_by: null,
      p_requested_by_remote: requester
        ? { id: requester.id, username: typeof requester.username === 'string' ? requester.username : null }
        : null,
    })
    if (sendRpcError(res, error, 'discord_bridge_import_start_internal', 'generic')) return
    res.status(201).json({ imports: data ?? [] })
  }))

  router.patch('/:id', ...open, handler(async (req, res) => {
    const patch = req.body
    if (!isObject(patch)) return res.status(400).json({ code: 'invalid_patch' })
    const { data, error } = await supabase.rpc('discord_bridge_import_update', {
      p_bridge_id: bridgeId(req),
      p_import_id: req.params.id,
      p_patch: patch,
    })
    if (sendRpcError(res, error, 'discord_bridge_import_update', 'patch')) return
    res.json({ import: data })
  }))

  router.post('/:id/cancel', ...open, handler(async (req, res) => {
    const { data, error } = await supabase.rpc('discord_bridge_import_cancel_internal', {
      p_bridge_id: bridgeId(req),
      p_import_id: req.params.id,
    })
    if (sendRpcError(res, error, 'discord_bridge_import_cancel_internal', 'generic')) return
    res.json({ imports: data ?? [] })
  }))

  router.post('/:id/messages', ...open, handler(async (req, res) => {
    const raw = (req.body as { messages?: unknown } | undefined)?.messages
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BATCH) {
      return res.status(400).json({ code: 'invalid_batch' })
    }
    // A malformed or future-dated message is refused alone; the batch carries on. An entry
    // without a Discord id has nothing to answer under.
    const refused: Array<{ discord_message_id: string; reason: string }> = []
    const now = Date.now()
    let items: PreparedInput[] = []
    for (const entry of raw) {
      const id = messageId(entry)
      if (!id) continue
      const item = validateMessage(entry)
      if (!item) refused.push({ discord_message_id: id, reason: 'invalid' })
      else if (isFuture(item.rest.created_at, now) || isFuture(item.rest.edited_at, now)) {
        refused.push({ discord_message_id: id, reason: 'future_date' })
      } else items.push(item)
    }
    const refusedIds = refused.map((r) => r.discord_message_id)
    // `rejected` is present when the insert function answered or this route refused a message.
    const answer = (body: { inserted: unknown[]; skipped: string[]; rejected?: unknown[] }) =>
      res.json({
        inserted: body.inserted,
        skipped: [...body.skipped, ...refusedIds],
        ...(body.rejected !== undefined || refused.length > 0
          ? { rejected: [...(body.rejected ?? []), ...refused] }
          : {}),
      })

    // The job's channel is the one the content pipeline resolves mentions and mirrors media in.
    // A job that is not running is refused before any attachment is mirrored (the RPC guard
    // still covers a race).
    const { data: job, error: jobError } = await supabase
      .from('discord_bridge_imports')
      .select('harmony_channel_id, state')
      .eq('id', req.params.id)
      .eq('bridge_id', bridgeId(req))
      .maybeSingle()
    if (jobError) {
      console.error('discord_bridge_imports select failed:', jobError.code, jobError.message)
      return res.status(500).json({ error: 'Import request failed' })
    }
    const found = job as { harmony_channel_id?: string; state?: string } | null
    if (!found?.harmony_channel_id) return res.status(404).json({ code: 'import_not_found' })
    if (found.state !== 'running') return notRunning(res)
    const channelId = found.harmony_channel_id

    // Discord ids already in the channel (a live relay or an earlier attempt) are skipped
    // without preparing or mirroring their content. bridge_import_present_ids repeats the
    // predicate of the partial unique index, so the lookup is an index probe.
    const { data: existing, error: existingError } = await supabase.rpc('bridge_import_present_ids', {
      p_bot_id: botId(req),
      p_import_id: req.params.id,
      p_ids: items.map((item) => item.discord_message_id),
    })
    if (sendRpcError(res, existingError, 'bridge_import_present_ids', 'batch')) return
    const present = new Set<string>(Array.isArray(existing) ? (existing as string[]) : [])
    const already = items.filter((item) => present.has(item.discord_message_id)).map((item) => item.discord_message_id)
    items = items.filter((item) => !present.has(item.discord_message_id))
    if (items.length === 0) return answer({ inserted: [], skipped: already })

    // The per-minute limit of the instance, taken before any file is fetched.
    const { data: admitted, error: admitError } = await supabase.rpc('bridge_import_admit', {
      p_bot_id: botId(req),
      p_import_id: req.params.id,
      p_count: items.length,
    })
    if (sendRpcError(res, admitError, 'bridge_import_admit', 'batch')) return
    const admission = admitted as { admitted?: boolean; not_running?: boolean; retry_after?: number } | null
    if (admission?.not_running === true) return notRunning(res)
    if (admission?.admitted !== true) {
      return retryLater(res, 'import_rate_limited', Number(admission?.retry_after) || 60)
    }

    // Imported messages are bridge-authored: the discord_user key keeps typed @everyone as text.
    const prepared: Array<{ parts: unknown[]; mirrorDeferred: boolean } | null> = new Array(items.length).fill(null)
    for (let i = 0; i < items.length; i += PREPARE_CONCURRENCY) {
      await Promise.all(items.slice(i, i + PREPARE_CONCURRENCY).map(async (item, offset) => {
        prepared[i + offset] = await prepareBotMessageContent({
          content: withoutMentions(item.content),
          metadata: { discord_user: item.rest.discord_user ?? {} },
          channelId,
          botId: botId(req),
        })
      }))
    }

    const messages: Record<string, unknown>[] = []
    const deferredIds = new Set<string>()
    const dropped: string[] = [...already]
    items.forEach((item, i) => {
      const content = prepared[i]?.parts
      if (!Array.isArray(content) || content.length === 0) dropped.push(item.discord_message_id)
      else {
        messages.push({ ...item.rest, content })
        if (prepared[i]?.mirrorDeferred) deferredIds.add(item.discord_message_id)
      }
    })
    if (messages.length === 0) return answer({ inserted: [], skipped: dropped })

    const { data, error } = await supabase.rpc('bridge_import_messages', {
      p_bot_id: botId(req),
      p_import_id: req.params.id,
      p_messages: messages,
    })
    // Files mirrored into the parts of a message that is then not stored are removed.
    const mirrored = (keep: (id: string) => boolean) =>
      items.flatMap((item, i) => (keep(item.discord_message_id) ? [] : ((prepared[i]?.parts ?? []) as unknown[])))
    if (error) {
      await discardMirroredParts(mirrored(() => false), error)
      const message = error.message ?? ''
      if (message === 'invalid_message' || message === 'invalid_thread') {
        return res.status(400).json({ code: 'invalid_batch', detail: message, discord_message_id: error.details ?? null })
      }
      sendRpcError(res, error, 'bridge_import_messages', 'batch')
      return
    }
    const result = data as {
      inserted?: unknown[]
      skipped?: string[]
      rejected?: Array<{ discord_message_id: string; reason: string }>
      not_running?: boolean
    } | null
    if (!result || result.not_running === true) {
      await discardMirroredParts(mirrored(() => false))
      return notRunning(res)
    }
    // Only messages that were inserted and still carry Discord links go to the mirror queue.
    const toQueue = ((result.inserted ?? []) as Array<{ id?: string; discord_message_id?: string }>)
      .filter((row) => typeof row?.id === 'string' && row.discord_message_id !== undefined && deferredIds.has(row.discord_message_id))
      .map((row) => row.id as string)
    await enqueueMirror(toQueue)
    const stored = new Set(((result.inserted ?? []) as Array<{ discord_message_id?: string }>).map((row) => row?.discord_message_id))
    await discardMirroredParts(mirrored((id) => stored.has(id)))
    // rejected (a message that broke a check) is also in skipped, so a bridge that predates the
    // field still sees every id answered.
    answer({
      inserted: result.inserted ?? [],
      skipped: [...(result.skipped ?? []), ...dropped],
      ...(Array.isArray(result.rejected) ? { rejected: result.rejected } : {}),
    })
  }))

  router.post('/:id/threads', ...open, handler(async (req, res) => {
    if (!isObject(req.body)) return res.status(400).json({ code: 'invalid_thread' })
    const { data, error } = await supabase.rpc('bridge_import_thread', {
      p_bot_id: botId(req),
      p_import_id: req.params.id,
      p_thread: req.body,
    })
    if (sendRpcError(res, error, 'bridge_import_thread', 'thread')) return
    if (data == null) return notRunning(res)
    res.json({ thread_id: data })
  }))

  router.post('/:id/replies/link', ...open, handler(async (req, res) => {
    const { data, error } = await supabase.rpc('bridge_import_link_replies', {
      p_bot_id: botId(req),
      p_import_id: req.params.id,
    })
    if (sendRpcError(res, error, 'bridge_import_link_replies', 'generic')) return
    if (data == null) return notRunning(res)
    res.json({ linked: data })
  }))

  return router
}
