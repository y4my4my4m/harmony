/**
 * Crawl of encrypted rooms' history for search: pages back from the newest message, decrypts
 * each page with the keys this device holds and indexes it (encryptedSearchIndex.ts). Spans
 * record what was read, so a later crawl reads only messages newer than the last one and
 * skips to where the previous crawl stopped.
 *
 * Pages read `messages` under RLS, as the message list does, newest first, keyed by
 * (created_at, id): get_message_page leaves out thread replies, adds reactions and pages by
 * created_at alone. RLS applies READ_MESSAGE_HISTORY. A room's readable start (`floor`) ends
 * the crawl where earlier messages carry keys this member never receives: the join time under
 * history visibility 'none' or 'pinned' (whose pinned messages before it are read once) and in
 * group conversations (20261028200001_megolm_history_visibility.sql).
 *
 * One request at a time, PAGE_INTERVAL_MS apart; failures back off 1, 2, 4 and 8 s before the
 * crawl gives up. Rooms advance together: the next page goes to the room whose crawl is newest.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { mergeSpans, type EncryptedSearchIndex, type HistorySpan, type SpanEdge } from './encryptedSearchIndex'
import type { Message } from '@/types'

export const PAGE_SIZE = 100
export const PAGE_INTERVAL_MS = 400
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]

export interface ScanRoom {
  room: string
  kind: 'channel' | 'conversation'
  /** Readable start, microseconds since the epoch; absent: the start of the room. */
  floor?: number
  /** Pinned messages before the floor are readable (history visibility 'pinned'). */
  pinnedBeforeFloor?: boolean
}

export interface ScanProgress {
  /** Every room is searched back to this time, ms; null before the first page. */
  reachedAt: number | null
  /** Rooms whose crawl reached their readable start. */
  finished: number
  rooms: number
  pages: number
}

export type ScanOutcome = 'done' | 'stopped' | 'error'

export interface ScanDeps {
  index: EncryptedSearchIndex
  /** Decrypted rows before `before` (exclusive), newest first, at or after `floor`. */
  loadPage(room: ScanRoom, before: SpanEdge | null, limit: number): Promise<Message[]>
  /** Decrypted pinned rows before the floor. */
  loadPinnedBefore(room: ScanRoom, floor: number): Promise<Message[]>
  /** Indexes decrypted rows and records the rest as unreadable. */
  record(index: EncryptedSearchIndex, messages: Message[]): Promise<void>
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** Microseconds since the epoch of a timestamptz as PostgREST writes it, or of a Date. */
export function timeMicros(value: string | Date): number {
  if (value instanceof Date) return value.getTime() * 1000
  const ms = Date.parse(value)
  const frac = /\.(\d+)/.exec(value)?.[1] ?? ''
  const micros = frac.length > 3 ? Number(frac.slice(3, 6).padEnd(3, '0')) : 0
  return ms * 1000 + micros
}

/** ISO 8601 with microseconds, as PostgREST filters read it. */
export function microsIso(us: number): string {
  const ms = Math.floor(us / 1000)
  const rest = String(us - ms * 1000).padStart(3, '0')
  return new Date(ms).toISOString().replace(/Z$/, `${rest}Z`)
}

export function messageEdge(message: Pick<Message, 'id' | 'created_at'>): SpanEdge {
  return { at: timeMicros(message.created_at as unknown as string | Date), id: message.id }
}

function before(a: SpanEdge, b: SpanEdge): boolean {
  return a.at < b.at || (a.at === b.at && a.id < b.id)
}

function within(edge: SpanEdge, span: HistorySpan): boolean {
  return !before(span.hi, edge) && (span.lo === null || !before(edge, span.lo))
}

/** The span reaches the room's readable start under `floor`. */
export function reachesStart(span: HistorySpan, floor: number | undefined): boolean {
  if (span.lo !== null) return false
  if (span.floor === undefined) return true
  return floor !== undefined && floor >= span.floor
}

interface RoomState {
  room: ScanRoom
  spans: HistorySpan[]
  cursor: SpanEdge | null
  started: boolean
  finished: boolean
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export async function scanHistory(
  rooms: ScanRoom[],
  deps: ScanDeps,
  options: { signal?: AbortSignal; onProgress?: (progress: ScanProgress) => void; onPage?: () => void } = {},
): Promise<ScanOutcome> {
  const { signal } = options
  const states: RoomState[] = await Promise.all(rooms.map(async room => ({
    room,
    spans: mergeSpans(await deps.index.spans(room.room)),
    cursor: null,
    started: false,
    finished: false,
  })))
  let pages = 0
  let last = 0

  const progress = () => {
    const open = states.filter(s => !s.finished)
    const reached = open.length
      ? (open.some(s => !s.started) ? null : Math.max(...open.map(s => s.cursor!.at)) / 1000)
      : null
    options.onProgress?.({ reachedAt: reached, finished: states.length - open.length, rooms: states.length, pages })
  }

  const remember = async (state: RoomState, span: HistorySpan) => {
    state.spans = mergeSpans([...state.spans, span])
    await deps.index.addSpan(state.room.room, span)
  }

  const finish = async (state: RoomState, top: SpanEdge | null) => {
    if (top) await remember(state, { lo: null, hi: top, ...(state.room.floor !== undefined ? { floor: state.room.floor } : {}) })
    if (state.room.floor !== undefined && state.room.pinnedBeforeFloor) {
      const pinned = await deps.loadPinnedBefore(state.room, state.room.floor)
      await deps.record(deps.index, pinned)
    }
    state.finished = true
  }

  /** Moves a cursor inside a read span to the span's lower end. True when nothing is left below. */
  const skipRead = (state: RoomState): boolean => {
    if (!state.cursor) return false
    const span = state.spans.find(s => within(state.cursor!, s))
    if (!span) return false
    if (span.lo === null) {
      if (reachesStart(span, state.room.floor)) return true
      // A lower floor than the crawl stopped at: read on below the old one.
      state.cursor = { at: span.floor!, id: '' }
      return false
    }
    state.cursor = span.lo
    return false
  }

  progress()
  while (!signal?.aborted) {
    const open = states.filter(s => !s.finished)
    if (open.length === 0) return 'done'
    const state = open.reduce((a, b) => {
      if (!a.started) return a
      if (!b.started) return b
      return before(a.cursor!, b.cursor!) ? b : a
    })

    if (skipRead(state)) {
      state.finished = true
      progress()
      continue
    }

    const wait = last + PAGE_INTERVAL_MS - Date.now()
    if (wait > 0) await deps.sleep(wait, signal)
    if (signal?.aborted) break

    let page: Message[] | null = null
    for (let attempt = 0; page === null; attempt++) {
      try {
        last = Date.now()
        page = await deps.loadPage(state.room, state.cursor, PAGE_SIZE)
      } catch (error) {
        debug.warn('Search crawl page failed:', error)
        if (attempt >= RETRY_DELAYS_MS.length) return 'error'
        await deps.sleep(RETRY_DELAYS_MS[attempt], signal)
        if (signal?.aborted) return 'stopped'
      }
    }
    if (signal?.aborted) break
    pages++

    const cursor = state.cursor
    // The newest read span below the cursor: rows inside it are read already.
    const below = state.spans.find(s => !cursor || before(s.hi, cursor))
    const fresh = below ? page.filter(m => before(below.hi, messageEdge(m))) : page
    await deps.record(deps.index, fresh)
    state.started = true

    const top = cursor ?? (page.length ? messageEdge(page[0]) : null)
    if (page.length === 0) {
      await finish(state, top)
    } else if (below && fresh.length < page.length) {
      // Nothing between the cursor and the span below: a span to it. Without a cursor and
      // nothing newer, there is nothing new to record.
      if (cursor || fresh.length) await remember(state, { lo: below.hi, hi: top! })
      state.cursor = below.hi
    } else if (page.length < PAGE_SIZE) {
      await finish(state, top)
    } else {
      const oldest = messageEdge(page[page.length - 1])
      await remember(state, { lo: oldest, hi: top! })
      state.cursor = oldest
    }
    options.onPage?.()
    progress()
  }
  return 'stopped'
}

// ---------------------------------------------------------------------------
// Pages from the database
// ---------------------------------------------------------------------------

async function decrypt(rows: Message[]): Promise<Message[]> {
  const { processMessageDecryption } = await import('@/utils/messageDecryption')
  return processMessageDecryption(rows, { index: false })
}

export async function loadHistoryPage(room: ScanRoom, cursor: SpanEdge | null, limit: number): Promise<Message[]> {
  let query = supabase
    .from('messages')
    .select('*')
    .not('is_deleted', 'is', true)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)
  query = room.kind === 'channel' ? query.eq('channel_id', room.room) : query.eq('conversation_id', room.room)
  if (room.floor !== undefined) query = query.gte('created_at', microsIso(room.floor))
  if (cursor) {
    const at = microsIso(cursor.at)
    query = cursor.id
      ? query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`)
      : query.lt('created_at', at)
  }
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return decrypt((data ?? []) as Message[])
}

export async function loadPinnedBefore(room: ScanRoom, floor: number): Promise<Message[]> {
  let query = supabase
    .from('messages')
    .select('*')
    .not('is_deleted', 'is', true)
    .eq('is_pinned', true)
    .lt('created_at', microsIso(floor))
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)
  query = room.kind === 'channel' ? query.eq('channel_id', room.room) : query.eq('conversation_id', room.room)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return decrypt((data ?? []) as Message[])
}

export async function recordPage(index: EncryptedSearchIndex, messages: Message[]): Promise<void> {
  const { searchableText } = await import('@/utils/searchTokens')
  const readable = messages.filter(m => m.decrypted && !m.is_system)
  const unreadable = messages.filter(m => m.encrypted && !m.decrypted && !m.is_system)
  await index.add(readable.map(message => ({ message, text: searchableText(message.content) })))
  await index.markUnreadable(unreadable)
}

export function databaseScanDeps(index: EncryptedSearchIndex): ScanDeps {
  return { index, loadPage: loadHistoryPage, loadPinnedBefore, record: recordPage, sleep }
}

// ---------------------------------------------------------------------------
// Readable start of a room
// ---------------------------------------------------------------------------

/**
 * Where this member's readable history of a room starts, microseconds; undefined: the room's
 * start. Mirrors public.room_joined_at and megolm_key_scope_allowed: a direct conversation has
 * no earlier history, a group conversation starts at the member's joined_at, a channel at the
 * server join under 'none' or 'pinned'. A channel's READ_MESSAGE_HISTORY cutoff
 * (channelHistoryCutoff.ts) applies over either.
 */
export async function readableFloor(
  target: { kind: 'conversation'; room: string; profileId: string; type?: string }
    | { kind: 'channel'; room: string; profileId: string; serverId?: string | null; visibility: 'all' | 'pinned' | 'none'; cutoff?: string | null },
): Promise<{ floor?: number; pinnedBeforeFloor?: boolean }> {
  try {
    if (target.kind === 'conversation') {
      let type = target.type
      if (!type) {
        const { data } = await supabase.from('conversations').select('type').eq('id', target.room).maybeSingle()
        type = data?.type ?? 'direct'
      }
      if (type === 'direct') return {}
      const { data } = await supabase
        .from('conversation_participants')
        .select('joined_at')
        .eq('conversation_id', target.room)
        .eq('user_id', target.profileId)
        .is('left_at', null)
        .order('joined_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return data?.joined_at ? { floor: timeMicros(data.joined_at) } : {}
    }

    const cutoff = target.cutoff && target.cutoff !== 'infinity' ? timeMicros(target.cutoff) : undefined
    if (target.visibility === 'all' || !target.serverId) return cutoff !== undefined ? { floor: cutoff } : {}
    const { data: membership } = await supabase
      .from('user_servers')
      .select('created_at')
      .eq('server_id', target.serverId)
      .eq('user_id', target.profileId)
      .eq('status', 'accepted')
      .maybeSingle()
    let joined = membership?.created_at as string | undefined
    if (!joined) {
      const { data: server } = await supabase.from('servers').select('owner, created_at').eq('id', target.serverId).maybeSingle()
      if (server?.owner === target.profileId) joined = server.created_at
    }
    const join = joined ? timeMicros(joined) : undefined
    const floor = join !== undefined && cutoff !== undefined ? Math.max(join, cutoff) : join ?? cutoff
    return {
      ...(floor !== undefined ? { floor } : {}),
      ...(target.visibility === 'pinned' && join !== undefined && (cutoff === undefined || join >= cutoff) ? { pinnedBeforeFloor: true } : {}),
    }
  } catch (error) {
    debug.warn('Readable history start unknown:', error)
    return {}
  }
}
