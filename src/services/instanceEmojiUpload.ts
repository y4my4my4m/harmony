import { v4 as uuidv4 } from 'uuid'
import { supabase } from '@/supabase'
import {
  emojiNameFromFile,
  prepareEmojiImage,
  storeEmojiImage,
  type EmojiUploadOptions,
} from '@/services/emojiService'
import { INSTANCE_EMOJI_FOLDER, type InstanceEmojiRow } from '@/services/InstanceEmojiAdminService'

/**
 * Admin upload: prepareEmojiImage and storeEmojiImage write <INSTANCE_EMOJI_FOLDER>/<uuid>.<ext>
 * to the emojis bucket, then create_instance_emoji records it. A refused record removes the
 * object and rethrows: 42501 not an admin, 22023 a bad path or url, 23505 a file already
 * recorded. Throws UploadRejectedError for a file outside the bucket limits.
 */
export async function uploadInstanceEmoji(file: File, options: EmojiUploadOptions = {}): Promise<InstanceEmojiRow> {
  const prepared = await prepareEmojiImage(file)
  const path = `${INSTANCE_EMOJI_FOLDER}/${uuidv4()}.${prepared.extension}`
  const url = await storeEmojiImage(path, prepared, { label: file.name, ...options })
  const { data, error } = await supabase.rpc('create_instance_emoji', {
    p_name: emojiNameFromFile(file.name),
    p_path: path,
    p_url: url,
  })
  if (error || !data) {
    await supabase.storage.from('emojis').remove([path])
    throw error ?? new Error('create_instance_emoji returned no row')
  }
  const row = data as Record<string, any>
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    domain: null,
    scope: 'instance',
    uploader: row.uploader ?? null,
    uploader_username: null,
    created_at: row.created_at,
    usage_count: row.usage_count ?? 0,
    reaction_count: 0,
    total_count: 0,
    is_ai_generated: false,
  }
}
