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
 * A page ends at the newest read span below it, so a crawl with nothing new reads no rows.
 *
 * Pages decrypt with the keys this device holds and request none: a crawl of a late joiner's
 * history would otherwise ask other members for every session in it. Messages left unreadable
 * are read again when a key arrives for their room (megolm-key-received) and on the first crawl
 * of each index this page session.
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
  /**
   * Decrypted rows before `before` and after `after` (both exclusive), newest first, at or
   * after `floor`.
   */
  loadPage(room: ScanRoom, before: SpanEdge | null, limit: number, after?: SpanEdge): Promise<Message[]>
  /** Decrypted pinned rows before the floor. */
  loadPinnedBefore(room: ScanRoom, floor: number): Promise<Message[]>
  /** Decrypted rows of the room by id; an id left out is deleted or no longer visible. */
  loadMessages?(room: ScanRoom, ids: string[]): Promise<Message[]>
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

// ---------------------------------------------------------------------------
// Key arrivals
// ---------------------------------------------------------------------------

// megolm-key-received events counted; the count at the last one per room, and at the last
// one for every room (roomId '*').
let keyArrivals = 0
let everyRoomArrival = 0
const roomArrivals = new Map<string, number>()
// keyArrivals when each room's unreadable messages were last read again, per index.
const retriedAt = new WeakMap<EncryptedSearchIndex, Map<string, number>>()

/** Counts a key arrival for the room; every room without one or with '*'. */
function noteKeyArrival(roomId?: string): void {
  keyArrivals++
  if (!roomId || roomId === '*') everyRoomArrival = keyArrivals
  else roomArrivals.set(roomId, keyArrivals)
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('megolm-key-received', (event) => {
    noteKeyArrival((event as CustomEvent<{ roomId?: string } | undefined>).detail?.roomId)
  })
}

function retriedFor(index: EncryptedSearchIndex): Map<string, number> {
  let map = retriedAt.get(index)
  if (!map) {
    map = new Map()
    retriedAt.set(index, map)
  }
  return map
}

function needsRetry(index: EncryptedSearchIndex, room: string): boolean {
  const at = retriedAt.get(index)?.get(room)
  return at === undefined || Math.max(everyRoomArrival, roomArrivals.get(room) ?? 0) > at
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

  /**
   * Reads the unreadable messages of rooms with a key arrival since their last retry again,
   * PAGE_SIZE ids per request, paced as pages. False when stopped.
   */
  const retryUnreadable = async (): Promise<boolean> => {
    const load = deps.loadMessages
    if (!load) return true
    for (const state of states) {
      const room = state.room.room
      if (!needsRetry(deps.index, room)) continue
      retriedFor(deps.index).set(room, keyArrivals)
      // Pinned messages before the floor are read too.
      const floor = state.room.floor !== undefined && !state.room.pinnedBeforeFloor ? state.room.floor / 1000 : undefined
      const ids = (await deps.index.unreadable([room], { [room]: floor })).map(u => u.id)
      for (let i = 0; i < ids.length; i += PAGE_SIZE) {
        const wait = last + PAGE_INTERVAL_MS - Date.now()
        if (wait > 0) await deps.sleep(wait, signal)
        if (signal?.aborted) return false
        const batch = ids.slice(i, i + PAGE_SIZE)
        let rows: Message[]
        try {
          last = Date.now()
          rows = await load(state.room, batch)
        } catch (error) {
          debug.warn('Search crawl could not read unreadable messages again:', error)
          retriedFor(deps.index).delete(room)
          break
        }
        await deps.record(deps.index, rows)
        const found = new Set(rows.map(m => m.id))
        const gone = batch.filter(id => !found.has(id))
        if (gone.length) await deps.index.remove(gone)
        options.onPage?.()
      }
    }
    return true
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
  if (!(await retryUnreadable())) return 'stopped'
  while (!signal?.aborted) {
    const open = states.filter(s => !s.finished)
    if (open.length === 0) return (await retryUnreadable()) ? 'done' : 'stopped'
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

    const cursor = state.cursor
    const floor = state.room.floor
    // The newest read span below the cursor and above the floor; the page ends at it.
    const below = state.spans.find(s => (!cursor || before(s.hi, cursor)) && (floor === undefined || s.hi.at >= floor))

    let page: Message[] | null = null
    for (let attempt = 0; page === null; attempt++) {
      try {
        last = Date.now()
        page = await deps.loadPage(state.room, cursor, PAGE_SIZE, below?.hi)
      } catch (error) {
        debug.warn('Search crawl page failed:', error)
        if (attempt >= RETRY_DELAYS_MS.length) return 'error'
        await deps.sleep(RETRY_DELAYS_MS[attempt], signal)
        if (signal?.aborted) return 'stopped'
      }
    }
    if (signal?.aborted) break
    pages++

    await deps.record(deps.index, page)
    state.started = true

    const top = cursor ?? (page.length ? messageEdge(page[0]) : null)
    if (page.length >= PAGE_SIZE) {
      const oldest = messageEdge(page[page.length - 1])
      await remember(state, { lo: oldest, hi: top! })
      state.cursor = oldest
    } else if (below) {
      // Every row between the cursor and the span below is read. Without a cursor and
      // nothing newer, there is nothing new to record.
      if (top) await remember(state, { lo: below.hi, hi: top })
      state.cursor = below.hi
    } else {
      await finish(state, top)
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
  return processMessageDecryption(rows, { index: false, heldKeysOnly: true })
}

export async function loadHistoryPage(room: ScanRoom, cursor: SpanEdge | null, limit: number, after?: SpanEdge): Promise<Message[]> {
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
  if (after) {
    const at = microsIso(after.at)
    query = after.id
      ? query.or(`created_at.gt.${at},and(created_at.eq.${at},id.gt.${after.id})`)
      : query.gte('created_at', at)
  }
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return decrypt((data ?? []) as Message[])
}

export async function loadMessagesById(room: ScanRoom, ids: string[]): Promise<Message[]> {
  let query = supabase
    .from('messages')
    .select('*')
    .in('id', ids)
    .not('is_deleted', 'is', true)
  query = room.kind === 'channel' ? query.eq('channel_id', room.room) : query.eq('conversation_id', room.room)
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
  return { index, loadPage: loadHistoryPage, loadPinnedBefore, loadMessages: loadMessagesById, record: recordPage, sleep }
}

// ---------------------------------------------------------------------------
// Readable start of a room
// ---------------------------------------------------------------------------

/** Lifetime of a server join lookup, ms: the channels of one server share it. */
const JOIN_CACHE_MS = 30_000
const serverJoins = new Map<string, { at: number; joined: Promise<string | undefined> }>()

/** When the member joined the server, the owner when it was created; undefined when neither. */
function serverJoinedAt(serverId: string, profileId: string): Promise<string | undefined> {
  const key = `${serverId}:${profileId}`
  const cached = serverJoins.get(key)
  if (cached && Date.now() - cached.at < JOIN_CACHE_MS) return cached.joined
  const joined = (async () => {
    const { data: membership } = await supabase
      .from('user_servers')
      .select('created_at')
      .eq('server_id', serverId)
      .eq('user_id', profileId)
      .eq('status', 'accepted')
      .maybeSingle()
    if (membership?.created_at) return membership.created_at as string
    const { data: server } = await supabase.from('servers').select('owner, created_at').eq('id', serverId).maybeSingle()
    return server?.owner === profileId ? server.created_at as string : undefined
  })()
  serverJoins.set(key, { at: Date.now(), joined })
  joined.catch(() => {
    if (serverJoins.get(key)?.joined === joined) serverJoins.delete(key)
  })
  return joined
}

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
    const joined = await serverJoinedAt(target.serverId, target.profileId)
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
