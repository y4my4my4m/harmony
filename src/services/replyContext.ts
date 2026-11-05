/**
 * The parent a reply's card previews (ReplyContext in types/activitypub.ts).
 *
 * Timeline reads embed the parent through posts.in_reply_to (REPLY_PARENT_EMBED, and
 * get_home_timeline_page's reply_parent, migration 20261105500001). A card whose post came
 * from a read without the embed asks requestReplyContext, which reads every such card of the
 * same tick in one request. A remote parent that is not stored goes to the federation
 * backend's POST /resolve-reply-parents, batched the same way, once per post per
 * RESOLVE_RETRY_MS.
 */

import { reactive } from 'vue'
import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'
import { debug } from '@/utils/debug'
import { messagePartsToRawText } from '@/utils/messageContentUtils'
import type { MediaAttachment, ReplyContext } from '@/types/activitypub'

/** Parent columns. posts RLS applies to the embedded row: a parent the reader may not read is null. */
export const REPLY_PARENT_COLUMNS =
  'id, content, content_warning, visibility, is_deleted, media_attachments, created_at, ' +
  'author:profiles!posts_author_id_fkey(id, username, display_name, avatar_url, domain, is_local)'

/** Many-to-one embed of the parent. `posts!in_reply_to(...)` embeds the replies instead. */
export const REPLY_PARENT_EMBED = `reply_parent:in_reply_to(${REPLY_PARENT_COLUMNS})`

/** Characters of parent text kept; the card clamps it to two lines. */
const SNIPPET_CHARS = 280
/** Posts per read; keeps the id list of the request URL short. */
const READ_CHUNK = 40
/** Posts per /resolve-reply-parents request; the backend takes at most 20. */
const RESOLVE_CHUNK = 20
const RESOLVE_RETRY_MS = 10 * 60_000

interface ReplyRow {
  id: string
  in_reply_to?: string | null
  metadata?: Record<string, any> | null
  reply_parent?: any
}

/**
 * Text of a parent's content: leading mentions dropped (a reply opens with the handles it
 * answers), whitespace collapsed, cut at SNIPPET_CHARS.
 */
export function replySnippet(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content.slice(0, SNIPPET_CHARS) : ''
  let start = 0
  while (start < content.length) {
    const part = content[start]
    if (part?.type === 'mention') { start++; continue }
    if (part?.type === 'text' && !String(part.text ?? '').trim()) { start++; continue }
    break
  }
  const parts = start < content.length ? content.slice(start) : content
  const text = messagePartsToRawText(parts).replace(/\s+/g, ' ').trim()
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text
}

/** Reply context of a row read with REPLY_PARENT_EMBED or from get_home_timeline_page. */
export function replyContextOf(row: ReplyRow): ReplyContext | null {
  if (!row.in_reply_to) {
    const url = row.metadata?.in_reply_to_ap_url
    return typeof url === 'string' && url ? { id: null, state: 'remote', url } : null
  }
  const parent = row.reply_parent
  // in_reply_to references a stored row (ON DELETE SET NULL): an absent parent is one RLS hides.
  if (!parent || !parent.author) return { id: row.in_reply_to, state: 'hidden' }
  if (parent.is_deleted) return { id: parent.id, state: 'deleted' }
  return {
    id: parent.id,
    state: 'post',
    author: {
      id: parent.author.id,
      username: parent.author.username,
      display_name: parent.author.display_name || parent.author.username,
      avatar_url: parent.author.avatar_url || undefined,
      domain: parent.author.domain,
      is_local: parent.author.is_local,
    },
    content: parent.content,
    content_preview: replySnippet(parent.content),
    content_warning: parent.content_warning || null,
    media_attachments: Array.isArray(parent.media_attachments) ? (parent.media_attachments as MediaAttachment[]) : [],
    created_at: parent.created_at,
    visibility: parent.visibility,
  }
}

/** Moves an embedded `reply_parent` to `reply_context`. Rows without the embed pass unchanged. */
export function withReplyContext<T extends Record<string, any>>(row: T): T {
  if (!row || !('reply_parent' in row)) return row
  const { reply_parent: _parent, ...rest } = row
  return { ...rest, reply_context: replyContextOf(row as unknown as ReplyRow) } as unknown as T
}

/** Contexts read since load, by reply post id. Wins over the post's own reply_context. */
export const replyContextCache = reactive(new Map<string, ReplyContext | null>())

const pendingReads = new Set<string>()
const pendingResolves = new Set<string>()
const resolvedAt = new Map<string, number>()
let readTimer: ReturnType<typeof setTimeout> | null = null
let resolveTimer: ReturnType<typeof setTimeout> | null = null

async function federationApiUrl(): Promise<string> {
  try {
    const { useActivityPubStore } = await import('@/stores/useActivityPub')
    return useActivityPubStore().federationApiUrl
  } catch {
    return apiUrl('/api/federation')
  }
}

async function readContexts(ids: string[], resolveRemote: boolean): Promise<void> {
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK)
    const { data, error } = await supabase
      .from('posts')
      .select(`id, in_reply_to, metadata, ${REPLY_PARENT_EMBED}`)
      .in('id', chunk)
    if (error) {
      debug.warn('[replyContext] read failed:', error.message)
      continue
    }
    const seen = new Set<string>()
    for (const row of (data ?? []) as ReplyRow[]) {
      seen.add(row.id)
      const context = replyContextOf(row)
      replyContextCache.set(row.id, context)
      if (resolveRemote && context?.state === 'remote') queueResolve(row.id)
    }
    for (const id of chunk) if (!seen.has(id)) replyContextCache.set(id, null)
  }
}

async function resolveRemoteParents(ids: string[]): Promise<void> {
  const base = await federationApiUrl()
  const { data: { session } } = await supabase.auth.getSession()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
    const chunk = ids.slice(i, i + RESOLVE_CHUNK)
    try {
      const response = await fetch(`${base}/resolve-reply-parents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ post_ids: chunk }),
      })
      if (!response.ok) continue
      const body = await response.json()
      const linked = chunk.filter((id) => body?.results?.[id] === 'linked')
      if (linked.length > 0) await readContexts(linked, false)
    } catch (error) {
      debug.warn('[replyContext] resolve failed:', error)
    }
  }
}

function queueResolve(postId: string) {
  const last = resolvedAt.get(postId)
  if (last !== undefined && Date.now() - last < RESOLVE_RETRY_MS) return
  resolvedAt.set(postId, Date.now())
  pendingResolves.add(postId)
  if (resolveTimer) return
  resolveTimer = setTimeout(() => {
    resolveTimer = null
    const ids = [...pendingResolves]
    pendingResolves.clear()
    void resolveRemoteParents(ids)
  }, 0)
}

/**
 * Fills replyContextCache for a reply whose card has no usable context: read with the
 * other cards of this tick, and its remote parent resolved when not stored.
 */
export function requestReplyContext(post: { id: string; in_reply_to?: string | null; metadata?: any; reply_context?: ReplyContext | null }) {
  if (!post?.id) return
  const own = post.reply_context
  if (own?.state === 'remote' || (!own && !post.in_reply_to && post.metadata?.in_reply_to_ap_url)) {
    queueResolve(post.id)
    return
  }
  if (own || !post.in_reply_to || replyContextCache.has(post.id) || pendingReads.has(post.id)) return
  pendingReads.add(post.id)
  if (readTimer) return
  readTimer = setTimeout(() => {
    readTimer = null
    const ids = [...pendingReads]
    pendingReads.clear()
    void readContexts(ids, true)
  }, 0)
}

/** Clears the cache and retry bookkeeping. Tests only. */
export function resetReplyContextCache() {
  replyContextCache.clear()
  pendingReads.clear()
  pendingResolves.clear()
  resolvedAt.clear()
  if (readTimer) clearTimeout(readTimer)
  if (resolveTimer) clearTimeout(resolveTimer)
  readTimer = null
  resolveTimer = null
}
