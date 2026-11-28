/**
 * Content of the messages and posts that notifications preview, for its custom emojis: the preview is
 * text the server wrote (extract_message_text), which leaves them out. Rows of the same tick are read
 * together; RLS hides what the reader may not read.
 */

import { shallowReactive } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { MessagePart } from '@/types'

export type PreviewKind = 'message' | 'post'

const TABLES: Record<PreviewKind, 'messages' | 'posts'> = { message: 'messages', post: 'posts' }
/** Ids per read; keeps the id list of the request URL short. */
const READ_CHUNK = 40
const MAX_KEPT = 1000

// Null: read, without custom emojis, deleted or not readable.
const rows = shallowReactive(new Map<string, MessagePart[] | null>())
const pending: Record<PreviewKind, Set<string>> = { message: new Set(), post: new Set() }
const reading = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

const keyOf = (kind: PreviewKind, id: string) => `${kind}:${id}`

/** The content of a row with custom emojis, once requestPreviewContent has read it. */
export function previewContent(kind: PreviewKind, id: string): MessagePart[] | null {
  return rows.get(keyOf(kind, id)) ?? null
}

export function requestPreviewContent(kind: PreviewKind, id: string): void {
  const key = keyOf(kind, id)
  if (rows.has(key) || reading.has(key) || pending[kind].has(id)) return
  pending[kind].add(id)
  timer ??= setTimeout(() => {
    timer = null
    for (const each of ['message', 'post'] as const) {
      const ids = [...pending[each]]
      pending[each].clear()
      for (let i = 0; i < ids.length; i += READ_CHUNK) void read(each, ids.slice(i, i + READ_CHUNK))
    }
  }, 0)
}

async function read(kind: PreviewKind, ids: string[]): Promise<void> {
  for (const id of ids) reading.add(keyOf(kind, id))
  const { data, error } = await supabase
    .from(TABLES[kind])
    .select('id, content')
    .in('id', ids)
    .eq('is_deleted', false)
    .contains('content', JSON.stringify([{ type: 'emoji' }]))
  for (const id of ids) reading.delete(keyOf(kind, id))
  if (error) {
    // Asked again by the next row that shows it.
    debug.warn('[previewContent] read failed:', error.message)
    return
  }
  if (rows.size + ids.length > MAX_KEPT) rows.clear()
  const found = new Map(((data ?? []) as unknown as { id: string; content: unknown }[]).map((row) => [row.id, row.content]))
  for (const id of ids) {
    const content = found.get(id)
    rows.set(keyOf(kind, id), Array.isArray(content) ? (content as MessagePart[]) : null)
  }
}

/** Forgets every row. Tests only. */
export function resetPreviewContent(): void {
  rows.clear()
  pending.message.clear()
  pending.post.clear()
  reading.clear()
  if (timer) clearTimeout(timer)
  timer = null
}
