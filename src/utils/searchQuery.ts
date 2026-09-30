/**
 * Discord-style message search grammar.
 *
 *   from:@user  mentions:@user  has:link|embed|file|image|video|sound  in:#channel
 *   before:DATE  after:DATE  during:DATE  pinned:true|false  free text
 *
 * A value holding spaces is double-quoted: from:"Display name". DATE is YYYY-MM-DD, YYYY-MM,
 * YYYY, today or yesterday, read in local time. before: excludes its day, after: excludes its
 * day, during: covers the day, month or year it names. Free text passes through untouched,
 * quotes and a leading minus included; search_messages parses it with websearch_to_tsquery.
 */

import type { Message, MessagePart } from '@/types'

export const FILTER_KEYS = ['from', 'mentions', 'has', 'in', 'before', 'during', 'after', 'pinned'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]

export const HAS_VALUES = ['link', 'embed', 'file', 'image', 'video', 'sound'] as const
export type HasValue = (typeof HAS_VALUES)[number]

export const DATE_KEYS = ['before', 'during', 'after'] as const
export type DateKey = (typeof DATE_KEYS)[number]

/** Keys resolved to an entity id before they reach the server. */
export const ENTITY_KEYS = ['from', 'mentions', 'in'] as const

export interface SearchToken {
  key: FilterKey
  /** Value as typed or chosen, without the key and without quotes: "alice", "general", "image". */
  value: string
  /** Profile id for from:/mentions:, channel id for in:. */
  id?: string
}

export interface ParsedQuery {
  text: string
  tokens: SearchToken[]
}

/** The token the caret is inside, for autocomplete. key is absent while the key itself is typed. */
export interface ActiveToken {
  key?: FilterKey
  partial: string
  start: number
  end: number
}

export type SearchSort = 'newest' | 'oldest' | 'relevance'

export interface SearchScope {
  serverId?: string
  conversationId?: string
}

/** Named parameters of public.search_messages. */
export interface SearchRpcParams {
  p_query: string | null
  p_server_id: string | null
  p_conversation_id: string | null
  p_channel_ids: string[] | null
  p_user_ids: string[] | null
  p_mentioned_user_ids: string[] | null
  p_has_url: boolean | null
  p_has_embed: boolean | null
  p_has_media: boolean | null
  p_has_image: boolean | null
  p_has_video: boolean | null
  p_has_audio: boolean | null
  p_pinned: boolean | null
  p_from_date: string | null
  p_to_date: string | null
  p_sort: SearchSort
  p_limit: number
  p_offset: number
  p_with_total: boolean
}

const KEY_SET = new Set<string>(FILTER_KEYS)
const HAS_SET = new Set<string>(HAS_VALUES)
const TOKEN_RE = /(^|\s)([a-z]+):("([^"]*)"?|\S*)/gi

export function isFilterKey(key: string): key is FilterKey {
  return KEY_SET.has(key)
}

export function isHasValue(value: string): value is HasValue {
  return HAS_SET.has(value)
}

/** Strips the @ or # a value carries for display. */
export function normalizeTokenValue(key: FilterKey, value: string): string {
  const v = value.trim()
  if ((key === 'from' || key === 'mentions') && v.startsWith('@')) return v.slice(1)
  if (key === 'in' && v.startsWith('#')) return v.slice(1)
  if (key === 'has' || key === 'pinned') return v.toLowerCase()
  return v
}

/** Splits input into filter tokens and free text. Unknown keys and empty values stay in the text. */
export function parseSearchQuery(input: string): ParsedQuery {
  const tokens: SearchToken[] = []
  let text = ''
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(input)) !== null) {
    const key = m[2].toLowerCase()
    const raw = m[4] !== undefined ? m[4] : m[3]
    if (!isFilterKey(key) || raw.trim() === '') continue
    const start = m.index + m[1].length
    text += input.slice(last, start)
    tokens.push({ key, value: normalizeTokenValue(key, raw) })
    last = m.index + m[0].length
  }
  text += input.slice(last)
  return { text: text.replace(/\s+/g, ' ').trim(), tokens }
}

/** Quotes a value that holds whitespace or a quote-free colon run. */
export function serializeToken(token: SearchToken): string {
  const prefix = token.key === 'from' || token.key === 'mentions' ? '@' : token.key === 'in' ? '#' : ''
  const body = prefix + token.value
  return /\s/.test(body) ? `${token.key}:"${body.replace(/"/g, '')}"` : `${token.key}:${body}`
}

export function serializeQuery(parsed: ParsedQuery): string {
  return [...parsed.tokens.map(serializeToken), parsed.text].filter(Boolean).join(' ').trim()
}

/** The whitespace-delimited word around the caret, read as a partial key or key:value. */
export function activeTokenAt(input: string, caret: number): ActiveToken {
  let start = caret
  while (start > 0 && !/\s/.test(input[start - 1])) start--
  // A quoted value may hold spaces: step back over an unterminated quote.
  const before = input.slice(0, caret)
  const quoted = /([a-z]+):"([^"]*)$/i.exec(before)
  if (quoted && isFilterKey(quoted[1].toLowerCase())) {
    return {
      key: quoted[1].toLowerCase() as FilterKey,
      partial: quoted[2],
      start: quoted.index,
      end: caret,
    }
  }
  let end = caret
  while (end < input.length && !/\s/.test(input[end])) end++
  const word = input.slice(start, caret)
  const colon = word.indexOf(':')
  if (colon > 0) {
    const key = word.slice(0, colon).toLowerCase()
    if (isFilterKey(key)) {
      return { key, partial: normalizeTokenValue(key, word.slice(colon + 1)), start, end }
    }
  }
  return { partial: word, start, end }
}

/** Words of free text worth highlighting: quotes dropped, -excluded words and `or` removed. */
export function highlightTerms(text: string): string {
  return text
    .replace(/"/g, ' ')
    .split(/\s+/)
    .filter(w => w && !w.startsWith('-') && w.toLowerCase() !== 'or')
    .join(' ')
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export interface DateSpan {
  /** Inclusive start, local midnight. */
  start: Date
  /** Exclusive end, local midnight. */
  end: Date
}

/** YYYY-MM-DD, YYYY-MM, YYYY, today, yesterday; local time. */
export function parseSearchDate(value: string, now: Date = new Date()): DateSpan | null {
  const v = value.trim().toLowerCase()
  if (v === 'today' || v === 'yesterday') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (v === 'yesterday' ? 1 : 0))
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) }
  }
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(v)
  if (!m) return null
  const year = Number(m[1])
  const month = m[2] !== undefined ? Number(m[2]) - 1 : undefined
  const day = m[3] !== undefined ? Number(m[3]) : undefined
  if (month !== undefined && (month < 0 || month > 11)) return null
  if (month === undefined) {
    return { start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) }
  }
  if (day === undefined) {
    return { start: new Date(year, month, 1), end: new Date(year, month + 1, 1) }
  }
  const start = new Date(year, month, day)
  if (start.getMonth() !== month || start.getDate() !== day) return null
  return { start, end: new Date(year, month, day + 1) }
}

/** YYYY-MM-DD of a local date. */
export function formatSearchDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** The instant one microsecond before `date`, as ISO 8601; search_messages bounds p_to_date inclusively. */
export function isoMicroBefore(date: Date): string {
  return new Date(date.getTime() - 1).toISOString().replace(/Z$/, '999Z')
}

/** Intersection of every date token: [from, to) as Dates, either side open. Empty when disjoint. */
export function dateRangeOf(tokens: SearchToken[], now: Date = new Date()): { from?: Date; to?: Date; empty: boolean } {
  let from: Date | undefined
  let to: Date | undefined
  for (const t of tokens) {
    if (t.key !== 'before' && t.key !== 'after' && t.key !== 'during') continue
    const span = parseSearchDate(t.value, now)
    if (!span) continue
    const lo = t.key === 'before' ? undefined : t.key === 'after' ? span.end : span.start
    const hi = t.key === 'before' ? span.start : t.key === 'after' ? undefined : span.end
    if (lo && (!from || lo > from)) from = lo
    if (hi && (!to || hi < to)) to = hi
  }
  return { from, to, empty: !!(from && to && from >= to) }
}

// ---------------------------------------------------------------------------
// Validation and RPC parameters
// ---------------------------------------------------------------------------

/** A token the server can apply: entity keys need an id, the rest a well-formed value. */
export function isTokenComplete(token: SearchToken, now: Date = new Date()): boolean {
  switch (token.key) {
    case 'from':
    case 'mentions':
    case 'in':
      return !!token.id
    case 'has':
      return isHasValue(token.value)
    case 'pinned':
      return token.value === 'true' || token.value === 'false'
    default:
      return parseSearchDate(token.value, now) !== null
  }
}

const HAS_PARAM: Record<HasValue, keyof SearchRpcParams> = {
  link: 'p_has_url',
  embed: 'p_has_embed',
  file: 'p_has_media',
  image: 'p_has_image',
  video: 'p_has_video',
  sound: 'p_has_audio',
}

/**
 * Maps a query onto search_messages. Incomplete tokens are dropped. in: applies only with a
 * server scope. Returns null when the query cannot match: disjoint dates, or nothing to search.
 */
export function buildSearchParams(
  parsed: ParsedQuery,
  scope: SearchScope,
  options: { sort?: SearchSort; page?: number; pageSize?: number; now?: Date } = {},
): SearchRpcParams | null {
  const now = options.now ?? new Date()
  const pageSize = options.pageSize ?? 25
  const tokens = parsed.tokens.filter(t => isTokenComplete(t, now))
  const ids = (key: FilterKey) => {
    const list = [...new Set(tokens.filter(t => t.key === key).map(t => t.id as string))]
    return list.length ? list : null
  }
  const dates = dateRangeOf(tokens, now)
  if (dates.empty) return null

  const text = parsed.text.trim()
  const params: SearchRpcParams = {
    p_query: text || null,
    p_server_id: scope.conversationId ? null : scope.serverId ?? null,
    p_conversation_id: scope.conversationId ?? null,
    p_channel_ids: scope.conversationId ? null : ids('in'),
    p_user_ids: ids('from'),
    p_mentioned_user_ids: ids('mentions'),
    p_has_url: null,
    p_has_embed: null,
    p_has_media: null,
    p_has_image: null,
    p_has_video: null,
    p_has_audio: null,
    p_pinned: null,
    p_from_date: dates.from ? dates.from.toISOString() : null,
    p_to_date: dates.to ? isoMicroBefore(dates.to) : null,
    p_sort: options.sort === 'relevance' && !text ? 'newest' : options.sort ?? 'newest',
    p_limit: pageSize,
    p_offset: Math.max(0, (options.page ?? 0) * pageSize),
    p_with_total: true,
  }
  for (const t of tokens) {
    if (t.key === 'has') (params[HAS_PARAM[t.value as HasValue]] as boolean | null) = true
    if (t.key === 'pinned') params.p_pinned = t.value === 'true'
  }
  const narrowed = tokens.length > 0 || !!text
  return narrowed ? params : null
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface SearchMember {
  id: string
  username: string
  displayName?: string
}

export interface SearchChannel {
  id: string
  name: string
}

function rank(fields: Array<string | undefined>, partial: string): number {
  const p = partial.toLowerCase()
  let best = 3
  for (const field of fields) {
    const f = (field || '').toLowerCase()
    if (!f) continue
    if (f === p) return 0
    if (f.startsWith(p)) best = Math.min(best, 1)
    else if (f.includes(p)) best = Math.min(best, 2)
  }
  return best
}

/** Exact matches first, then prefix, then substring; stable within a rank. */
export function suggestMembers(members: SearchMember[], partial: string, limit = 8): SearchMember[] {
  if (!partial) return members.slice(0, limit)
  return members
    .map((m, i) => ({ m, i, r: rank([m.username, m.displayName], partial) }))
    .filter(x => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map(x => x.m)
}

export function suggestChannels(channels: SearchChannel[], partial: string, limit = 8): SearchChannel[] {
  if (!partial) return channels.slice(0, limit)
  return channels
    .map((c, i) => ({ c, i, r: rank([c.name], partial) }))
    .filter(x => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map(x => x.c)
}

/** Gives a typed from:, mentions: or in: token the id of the one entity its value names exactly. */
export function resolveToken(
  token: SearchToken,
  entities: { members: SearchMember[]; channels: SearchChannel[] },
): SearchToken {
  if (token.id) return token
  const v = token.value.toLowerCase()
  if (token.key === 'from' || token.key === 'mentions') {
    const byName = entities.members.filter(m => m.username.toLowerCase() === v)
    const hits = byName.length ? byName : entities.members.filter(m => m.displayName?.toLowerCase() === v)
    return hits.length === 1 ? { ...token, id: hits[0].id, value: hits[0].username } : token
  }
  if (token.key === 'in') {
    const hits = entities.channels.filter(c => c.name.toLowerCase() === v)
    return hits.length === 1 ? { ...token, id: hits[0].id, value: hits[0].name } : token
  }
  return token
}

// ---------------------------------------------------------------------------
// Local matching, for decrypted messages the server cannot read
// ---------------------------------------------------------------------------

function partsOf(message: Message): MessagePart[] {
  return Array.isArray(message.content) ? message.content : []
}

function fileKind(part: MessagePart): string | null {
  if (part.type !== 'file') return null
  return (part.fileType || '').split('/')[0].toLowerCase()
}

/** has: over message parts, as detect_message_features reads them. */
export function messageHas(message: Message, value: HasValue): boolean {
  const parts = partsOf(message)
  switch (value) {
    case 'link':
      return parts.some(p => p.type === 'url')
    case 'embed':
      return parts.some(p => p.type === 'embed')
        || !!(message.metadata?.embeds && Object.keys(message.metadata.embeds).length > 0)
    case 'file':
      return parts.some(p => p.type === 'file')
    case 'image':
      return parts.some(p => fileKind(p) === 'image')
    case 'video':
      return parts.some(p => fileKind(p) === 'video')
    case 'sound':
      return parts.some(p => fileKind(p) === 'audio')
  }
}

/** Applies every non-text filter of params to one loaded message. */
export function messageMatchesParams(message: Message, params: SearchRpcParams): boolean {
  const created = new Date(message.created_at).getTime()
  if (params.p_from_date && created < new Date(params.p_from_date).getTime()) return false
  if (params.p_to_date && created > new Date(params.p_to_date).getTime()) return false
  if (params.p_user_ids && !(message.user_id && params.p_user_ids.includes(message.user_id))) return false
  if (params.p_channel_ids && !(message.channel_id && params.p_channel_ids.includes(message.channel_id))) return false
  if (params.p_mentioned_user_ids) {
    const mentioned = partsOf(message)
      .filter((p): p is Extract<MessagePart, { type: 'mention' }> => p.type === 'mention')
      .map(p => p.userId)
    if (!mentioned.some(id => params.p_mentioned_user_ids!.includes(id))) return false
  }
  if (params.p_pinned !== null && !!message.is_pinned !== params.p_pinned) return false
  for (const value of HAS_VALUES) {
    const wanted = params[HAS_PARAM[value]]
    if (wanted === true && !messageHas(message, value)) return false
  }
  return true
}
