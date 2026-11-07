import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'

/**
 * admin_list_emojis kinds (20261107100001_emoji_lifecycle.sql, emoji_kind). not_imported rows are
 * remote_emojis_cache rows: id is the cache id, domain its origin.
 */
export type AdminEmojiKind = 'instance' | 'imported' | 'federated' | 'server' | 'personal' | 'ai' | 'not_imported'
export type AdminEmojiKindFilter = 'all' | AdminEmojiKind
export type AdminEmojiStatus = 'active' | 'removed' | 'all'
export type AdminEmojiSort = 'newest' | 'oldest' | 'name' | 'usage'

export const ADMIN_EMOJI_KINDS: readonly AdminEmojiKindFilter[] = [
  'all', 'instance', 'imported', 'federated', 'server', 'personal', 'ai', 'not_imported',
]

/** Row of admin_list_emojis. */
export interface AdminEmojiRow {
  id: string
  kind: AdminEmojiKind
  name: string
  url: string
  domain: string | null
  scope: string | null
  server_id: string | null
  server_name: string | null
  uploader: string | null
  uploader_username: string | null
  created_at: string
  usage_count: number
  reaction_count: number
  deleted_at: string | null
  deleted_by_username: string | null
  imported_from: string | null
  hotlinked: boolean
  is_ai_generated: boolean
}

export interface AdminEmojiPage {
  rows: AdminEmojiRow[]
  total: number
}

/** Folder of admin-uploaded instance emoji files in bucket emojis; create_instance_emoji's path rule. */
export const INSTANCE_EMOJI_FOLDER = '00000000-0000-0000-0000-000000000000'

/** admin_list_emojis clamps limit to 200. */
export const ADMIN_EMOJI_PAGE_MAX = 200

/** rename_emoji's name rule. */
export const INSTANCE_EMOJI_NAME = /^[A-Za-z0-9_-]{2,64}$/

const KINDS = new Set<string>(ADMIN_EMOJI_KINDS)

function toRow(raw: Record<string, any>): AdminEmojiRow {
  return {
    id: String(raw.id),
    kind: (KINDS.has(raw.kind) && raw.kind !== 'all' ? raw.kind : 'instance') as AdminEmojiKind,
    name: String(raw.name ?? ''),
    url: String(raw.url ?? ''),
    domain: raw.domain ?? null,
    scope: raw.scope ?? null,
    server_id: raw.server_id ?? null,
    server_name: raw.server_name ?? null,
    uploader: raw.uploader ?? null,
    uploader_username: raw.uploader_username ?? null,
    created_at: raw.created_at,
    usage_count: Number(raw.usage_count ?? 0),
    reaction_count: Number(raw.reaction_count ?? 0),
    deleted_at: raw.deleted_at ?? null,
    deleted_by_username: raw.deleted_by_username ?? null,
    imported_from: raw.imported_from ?? null,
    hotlinked: raw.hotlinked === true,
    is_ai_generated: raw.is_ai_generated === true,
  }
}

export async function listAdminEmojis(params: {
  search?: string
  kind?: AdminEmojiKindFilter
  status?: AdminEmojiStatus
  sort?: AdminEmojiSort
  limit: number
  offset: number
}): Promise<AdminEmojiPage> {
  const { data, error } = await supabase.rpc('admin_list_emojis', {
    p_search: params.search?.trim() || null,
    p_kind: params.kind ?? 'all',
    p_status: params.status ?? 'active',
    p_sort: params.sort ?? 'newest',
    p_limit: params.limit,
    p_offset: params.offset,
  })
  if (error) throw error
  const raw = (data ?? []) as Record<string, any>[]
  return { rows: raw.map(toRow), total: raw.length ? Number(raw[0].total_count) : 0 }
}

/** rename_emoji: 22023 invalid name, 23505 taken, 42501 not allowed, P0002 absent. */
export async function renameEmoji(id: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('rename_emoji', { p_emoji_id: id, p_name: name.trim() })
  if (error) throw error
}

/** Soft delete: the row, file and reactions stay; the emoji leaves every picker. */
export async function removeEmoji(id: string): Promise<void> {
  const { error } = await supabase.rpc('remove_emoji', { p_emoji_id: id })
  if (error) throw error
}

/** restore_emoji: 23505 the name is held by another active emoji, 23514 the cap is reached. */
export async function restoreEmoji(id: string): Promise<void> {
  const { error } = await supabase.rpc('restore_emoji', { p_emoji_id: id })
  if (error) throw error
}

/**
 * Hard delete through admin_purge_emoji, then removal of the file it reports (a path in bucket
 * emojis; null for a file elsewhere or one another row shares). Resolves false when the row is
 * gone but the file remove failed.
 */
export async function purgeEmoji(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('admin_purge_emoji', { p_emoji_id: id })
  if (error) throw error
  const path = typeof data === 'string' && data ? data : null
  if (!path) return true
  const { error: storageError } = await supabase.storage.from('emojis').remove([path])
  return !storageError
}

/** Error code of the federation backend's admin emoji routes: { error: <code> }. */
export class AdminEmojiRequestError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'AdminEmojiRequestError'
  }
}

export interface ImportedEmoji {
  id: string
  name: string
  url: string
  imported_from: string | null
}

async function backendPost(path: string, body?: unknown): Promise<ImportedEmoji> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new AdminEmojiRequestError('network_error', 0)
  }
  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    const code = typeof payload?.error === 'string' ? payload.error : 'internal_error'
    throw new AdminEmojiRequestError(code, res.status)
  }
  const emoji = payload?.emoji
  if (!emoji || typeof emoji.id !== 'string') throw new AdminEmojiRequestError('internal_error', res.status)
  return {
    id: emoji.id,
    name: String(emoji.name ?? ''),
    url: String(emoji.url ?? ''),
    imported_from: emoji.imported_from ?? null,
  }
}

/** The backend downloads the remote image into the instance folder and records the copy. */
export function importRemoteEmoji(remoteEmojiId: string, name?: string): Promise<ImportedEmoji> {
  const trimmed = name?.trim()
  return backendPost('/api/federation/admin/emojis/import', {
    remoteEmojiId,
    ...(trimmed ? { name: trimmed } : {}),
  })
}

/** Copies a hotlinked instance emoji's image onto this instance's storage. */
export function rehostEmoji(emojiId: string): Promise<ImportedEmoji> {
  return backendPost(`/api/federation/admin/emojis/${encodeURIComponent(emojiId)}/rehost`)
}
