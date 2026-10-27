import { v4 as uuidv4 } from 'uuid'
import { supabase } from '@/supabase'
import {
  cleanupEmojiReferences,
  emojiNameFromFile,
  prepareEmojiImage,
  storeEmojiImage,
  type EmojiUploadOptions,
} from '@/services/emojiService'
import { invalidateEmojiResolverCache } from '@/services/emojiShortcodeResolver'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'

/** One of the caller's user-scope emojis: AI-generated or a personal upload. */
export interface MyEmoji {
  id: string
  name: string
  url: string | null
  is_ai_generated: boolean
  usage_count: number
  file_size: number | null
  created_at: string
}

const COLUMNS = 'id, name, url, is_ai_generated, usage_count, file_size, created_at'

function toMyEmoji(row: Record<string, any>): MyEmoji {
  return {
    id: row.id,
    name: row.name,
    url: row.url ?? null,
    is_ai_generated: row.is_ai_generated === true,
    usage_count: row.usage_count ?? 0,
    file_size: row.file_size ?? null,
    created_at: row.created_at,
  }
}

export async function listMyEmojis(profileId: string): Promise<MyEmoji[]> {
  const { data, error } = await supabase
    .from('emojis')
    .select(COLUMNS)
    .eq('scope', 'user')
    .eq('uploader', profileId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map(toMyEmoji)
}

/**
 * Personal upload: prepareEmojiImage and storeEmojiImage write <profile>/<uuid>.<ext> to the
 * emojis bucket, then create_my_emoji records it. A refused record removes the object and rethrows:
 * PERSONAL_EMOJI_LIMIT (23514), a bad path or url (22023), a file already recorded (23505).
 * Throws UploadRejectedError for a file outside the bucket limits.
 */
export async function uploadMyEmoji(profileId: string, file: File, options: EmojiUploadOptions = {}): Promise<MyEmoji> {
  const prepared = await prepareEmojiImage(file)
  const path = `${profileId}/${uuidv4()}.${prepared.extension}`
  const url = await storeEmojiImage(path, prepared, { label: file.name, ...options })
  const { data, error } = await supabase.rpc('create_my_emoji', {
    p_name: emojiNameFromFile(file.name),
    p_path: path,
    p_url: url,
  })
  if (error || !data) {
    await supabase.storage.from('emojis').remove([path])
    throw error ?? new Error('create_my_emoji returned no row')
  }
  return toMyEmoji(data)
}

/** rename_my_emoji: 22023 invalid name, 23505 name taken, P0002 not the caller's. */
export async function renameMyEmoji(id: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('rename_my_emoji', { p_emoji_id: id, p_name: name.trim() })
  if (error) throw error
}

/**
 * Deletes through the emojis_delete_user_scope policy. RLS filters a row the caller does
 * not own out of the delete, so an empty result raises P0002. The storage object stays,
 * as on admin_delete_instance_emoji: federated copies of posts reference its URL.
 */
export async function deleteMyEmoji(emoji: MyEmoji, profileId: string): Promise<void> {
  const { success } = await deleteMyEmojis([emoji], profileId)
  if (!success.length) throw Object.assign(new Error('Emoji not found'), { code: 'P0002' })
}

/** One delete for several of the caller's emojis; ids RLS filtered out land in failed. */
export async function deleteMyEmojis(
  emojis: MyEmoji[],
  profileId: string,
): Promise<{ success: string[]; failed: string[] }> {
  const ids = emojis.map((e) => e.id)
  const { data, error } = await supabase
    .from('emojis')
    .delete()
    .in('id', ids)
    .eq('scope', 'user')
    .eq('uploader', profileId)
    .select('id')
  if (error) throw error
  const deleted = new Set((data ?? []).map((row: { id: string }) => row.id))
  for (const emoji of emojis) {
    if (deleted.has(emoji.id)) {
      await cleanupEmojiReferences({ id: emoji.id, name: emoji.name, url: emoji.url ?? '', scope: 'user' })
    }
  }
  return { success: ids.filter((id) => deleted.has(id)), failed: ids.filter((id) => !deleted.has(id)) }
}

/** Refetches the picker's personal groups and drops resolved :name: lookups. */
export async function refreshPersonalEmojis(profileId: string): Promise<void> {
  invalidateEmojiResolverCache()
  await useEmojiCacheStore().loadPersonalEmojis(profileId, true)
}
