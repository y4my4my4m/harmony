import { supabase } from '@/supabase'

/** Row of admin_list_instance_emojis. */
export interface InstanceEmojiRow {
  id: string
  name: string
  url: string
  domain: string | null
  scope: string
  uploader: string | null
  uploader_username: string | null
  created_at: string
  usage_count: number
  reaction_count: number
  total_count: number
}

export type InstanceEmojiSource = 'all' | 'local' | 'remote'
export type InstanceEmojiSort = 'newest' | 'name'

export interface InstanceEmojiPage {
  rows: InstanceEmojiRow[]
  total: number
}

/** Mirrors the admin_rename_instance_emoji name check. */
export const INSTANCE_EMOJI_NAME = /^[A-Za-z0-9_-]{2,64}$/

export async function listInstanceEmojis(params: {
  search?: string
  source?: InstanceEmojiSource
  sort?: InstanceEmojiSort
  limit: number
  offset: number
}): Promise<InstanceEmojiPage> {
  const { data, error } = await supabase.rpc('admin_list_instance_emojis', {
    p_search: params.search?.trim() || null,
    p_source: params.source ?? 'all',
    p_sort: params.sort ?? 'newest',
    p_limit: params.limit,
    p_offset: params.offset,
  })
  if (error) throw error
  const rows = (data ?? []) as InstanceEmojiRow[]
  return {
    rows: rows.map((r) => ({ ...r, reaction_count: Number(r.reaction_count), total_count: Number(r.total_count) })),
    total: rows.length ? Number(rows[0].total_count) : 0,
  }
}

export async function renameInstanceEmoji(id: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('admin_rename_instance_emoji', { p_emoji_id: id, p_name: name.trim() })
  if (error) throw error
}

export async function deleteInstanceEmoji(id: string): Promise<void> {
  const { error } = await supabase.rpc('admin_delete_instance_emoji', { p_emoji_id: id })
  if (error) throw error
}
