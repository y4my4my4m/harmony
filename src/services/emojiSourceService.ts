/**
 * Where a custom emoji comes from, as get_emoji_source / get_emoji_source_by_url
 * (20261031300001_emoji_source.sql) answer it for the signed-in viewer. Server
 * details come only from these calls; a private server the viewer is not in
 * reads as 'unavailable', the same as a deleted one.
 *
 * An id is asked with the url it was seen with: a row whose url differs answers
 * 'unavailable', so a part pairing another emoji's id with its own image is not
 * credited to that emoji. An 'unavailable' id is asked again by url, which names
 * the instance of a federated emoji stored with its origin's id.
 */
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface EmojiSourceEmoji {
  id: string
  name: string
  url: string
}

export interface EmojiSourceServer {
  id: string
  name: string
  icon: string | null
  public: boolean
  memberCount: number
  isMember: boolean
  joinable: boolean
  /** host_domain of a remote server copy; null for a local server. */
  domain: string | null
  /** Up to 9 other emoji of the server. */
  emojis: EmojiSourceEmoji[]
}

export interface EmojiSourceOwner {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  domain: string | null
  isLocal: boolean
}

export type EmojiSource =
  | { kind: 'server'; server: EmojiSourceServer }
  | { kind: 'personal'; owner: EmojiSourceOwner | null }
  | { kind: 'instance' }
  | { kind: 'remote'; domain: string }
  | { kind: 'unavailable' }

export interface EmojiSourceRef {
  /** emojis.id; a non-uuid id, or one without a url, is ignored. */
  id?: string | null
  url?: string | null
  name?: string | null
}

const UNAVAILABLE: EmojiSource = Object.freeze({ kind: 'unavailable' })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TTL_MS = 60_000

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

function parseEmojis(value: unknown): EmojiSourceEmoji[] {
  if (!Array.isArray(value)) return []
  const out: EmojiSourceEmoji[] = []
  for (const item of value) {
    const row = item as Record<string, unknown> | null
    const id = str(row?.id)
    const name = str(row?.name)
    const url = str(row?.url)
    if (id && name && url) out.push({ id, name, url })
  }
  return out.slice(0, 9)
}

/** RPC jsonb to EmojiSource; anything malformed is 'unavailable'. */
export function parseEmojiSource(raw: unknown): EmojiSource {
  const row = raw as Record<string, unknown> | null
  switch (row?.kind) {
    case 'server': {
      const s = row.server as Record<string, unknown> | null
      const id = str(s?.id)
      const name = str(s?.name)
      if (!s || !id || !name) return UNAVAILABLE
      return {
        kind: 'server',
        server: {
          id,
          name,
          icon: str(s.icon),
          public: s.public === true,
          memberCount: typeof s.member_count === 'number' ? s.member_count : 0,
          isMember: s.is_member === true,
          joinable: s.joinable === true,
          domain: str(s.domain),
          emojis: parseEmojis(s.emojis),
        },
      }
    }
    case 'personal': {
      const o = row.owner as Record<string, unknown> | null
      const id = str(o?.id)
      const username = str(o?.username)
      return {
        kind: 'personal',
        owner: o && id && username
          ? {
              id,
              username,
              displayName: str(o.display_name),
              avatarUrl: str(o.avatar_url),
              domain: str(o.domain),
              isLocal: o.is_local !== false,
            }
          : null,
      }
    }
    case 'instance':
      return { kind: 'instance' }
    case 'remote': {
      const domain = str(row.domain)
      return domain ? { kind: 'remote', domain } : UNAVAILABLE
    }
    default:
      return UNAVAILABLE
  }
}

/** Cache key of a ref; null when there is nothing to ask about. */
export function emojiSourceKey(ref: EmojiSourceRef): string | null {
  if (!ref.url) return null
  if (ref.id && UUID_RE.test(ref.id)) return `id:${ref.id.toLowerCase()}\n${ref.url}\n${ref.name ?? ''}`
  return `url:${ref.url}\n${ref.name ?? ''}`
}

const cache = new Map<string, { at: number; value: Promise<EmojiSource> }>()

async function call(fn: string, args: Record<string, unknown>): Promise<EmojiSource> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) {
    debug.warn('[emojiSource] lookup failed:', error.message)
    throw error
  }
  return parseEmojiSource(data)
}

async function request(ref: EmojiSourceRef & { url: string }): Promise<EmojiSource> {
  const byUrl = () => call('get_emoji_source_by_url', { p_url: ref.url, p_name: ref.name || null })
  if (!ref.id || !UUID_RE.test(ref.id)) return byUrl()
  const answer = await call('get_emoji_source', { p_emoji_id: ref.id, p_url: ref.url })
  return answer.kind === 'unavailable' ? byUrl() : answer
}

/** Source of an emoji; 'unavailable' on any failure. Answers are kept for a minute. */
export function fetchEmojiSource(ref: EmojiSourceRef): Promise<EmojiSource> {
  const key = emojiSourceKey(ref)
  if (!key || !ref.url) return Promise.resolve(UNAVAILABLE)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = request({ ...ref, url: ref.url }).catch(() => {
    cache.delete(key)
    return UNAVAILABLE
  })
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Drops cached answers; membership changed. */
export function invalidateEmojiSources(): void {
  cache.clear()
}
