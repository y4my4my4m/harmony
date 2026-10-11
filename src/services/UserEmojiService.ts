import { supabase } from '@/supabase'
import { cleanupEmojiReferences } from '@/services/emojiService'
import { invalidateEmojiResolverCache } from '@/services/emojiShortcodeResolver'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'

/** One of the caller's user-scope emojis: AI-generated or a personal upload. */
export interface MyEmoji {
  id: string
  name: string
  url: string | null
  is_ai_generated: boolean
  usage_count: number
  created_at: string
}

/** Mirrors the rename_my_emoji name check. */
export const MY_EMOJI_NAME = /^[A-Za-z0-9_-]{2,64}$/

export async function listMyEmojis(profileId: string): Promise<MyEmoji[]> {
  const { data, error } = await supabase
    .from('emojis')
    .select('id, name, url, is_ai_generated, usage_count, created_at')
    .eq('scope', 'user')
    .eq('uploader', profileId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as MyEmoji[]).map((row) => ({ ...row, usage_count: row.usage_count ?? 0 }))
}

/** rename_my_emoji: 22023 invalid name, 23505 name taken, P0002 not the caller's. */
export async function renameMyEmoji(id: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('rename_my_emoji', { p_emoji_id: id, p_name: name.trim() })
  if (error) throw error
}

/**
 * Deletes through the emojis_delete_user_scope policy. RLS filters a row the caller does
 * not own out of the delete, so an empty result raises P0002. The storage object stays,
 * as on admin_delete_instance_emoji.
 */
export async function deleteMyEmoji(emoji: MyEmoji, profileId: string): Promise<void> {
  const { data, error } = await supabase
    .from('emojis')
    .delete()
    .eq('id', emoji.id)
    .eq('scope', 'user')
    .eq('uploader', profileId)
    .select('id')
  if (error) throw error
  if (!data?.length) throw Object.assign(new Error('Emoji not found'), { code: 'P0002' })
  await cleanupEmojiReferences({ id: emoji.id, name: emoji.name, url: emoji.url ?? '', scope: 'user' })
}

/** Refetches the picker's personal groups and drops resolved :name: lookups. */
export async function refreshPersonalEmojis(profileId: string): Promise<void> {
  invalidateEmojiResolverCache()
  await useEmojiCacheStore().loadPersonalEmojis(profileId, true)
}
