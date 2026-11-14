import { supabase } from '../config/supabase.js'
import { MESSAGE_MEDIA_BUCKET } from '../utils/messageMedia.js'

/**
 * Queues messages whose attachments still point at Discord for the background mirror worker.
 * Best effort: a miss is picked up by the worker's startup walk, so errors are logged, not thrown.
 */
export async function enqueueMirror(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return
  try {
    const { error } = await supabase.rpc('bridge_mirror_enqueue', { p_message_ids: messageIds })
    if (error) console.error('bridge_mirror_enqueue failed:', error.code, error.message)
  } catch (error: any) {
    console.error('bridge_mirror_enqueue failed:', error?.message || error)
  }
}

/** Names per bridge_mirror_unreferenced call and per storage remove. */
const REMOVE_BATCH = 500

/** A name the mirror gives an object: c/<channel id>/bridge/<bot id>/<uuid>.<ext>. */
const MIRROR_PATH = /^c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/bridge\/[^/]+\/[^/]+$/

/**
 * Removes from storage the mirrored files among `paths` that nothing references:
 * public.bridge_mirror_unreferenced(paths) names them (no live message or report snapshot holds
 * the object; the lookup reads idx_messages_media_refs, not the channel), so a path whose message
 * was stored stays. Names outside the mirror's c/<channel id>/bridge/ paths are ignored. Returns
 * the number removed. Best effort: errors are logged, and the federation backend's message_media
 * sweep removes an unreferenced object after a day.
 */
export async function removeUnreferencedMirrors(paths: string[]): Promise<number> {
  const names = [...new Set(paths.filter((path) => typeof path === 'string' && MIRROR_PATH.test(path)))]
  let removed = 0
  try {
    for (let i = 0; i < names.length; i += REMOVE_BATCH) {
      const batch = names.slice(i, i + REMOVE_BATCH)
      const { data, error } = await supabase.rpc('bridge_mirror_unreferenced', { p_paths: batch })
      if (error) throw new Error(`bridge_mirror_unreferenced failed: ${error.message}`)
      const deletable = (Array.isArray(data) ? data : [])
        .filter((name: unknown): name is string => typeof name === 'string' && batch.includes(name))
      if (deletable.length === 0) continue
      const { data: gone, error: removeError } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).remove(deletable)
      if (removeError) throw new Error(`storage remove failed: ${removeError.message}`)
      removed += gone?.length ?? 0
    }
  } catch (error: any) {
    console.error('Removing unreferenced mirror files failed:', error?.message || error)
  }
  return removed
}

/**
 * The database refused the statement and rolled it back: a PostgREST error whose code is a
 * SQLSTATE (class 00-99, P0, XX, HV or F0) or PGRSTnnn. Any other failure (a dropped connection,
 * a proxy timeout; supabase-js reports those with an empty code or a Node errno) leaves open
 * whether the statement committed.
 */
export function isDatabaseRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && /^(\d[0-9A-Z]{4}|(P0|XX|HV|F0)[0-9A-Z]{3}|PGRST\d+)$/.test(code)
}

/**
 * For content the pipeline prepared (prepareBotMessageContent) whose message was then not
 * stored: removes the files applyBridgeAttachmentPolicy mirrored into its parts. `error` is the
 * error the write returned, absent when it returned none (no row came back, the message was
 * skipped or rejected). With an error that is not a database refusal the write may still commit
 * after this call, so nothing is removed. Never throws.
 */
export async function discardMirroredParts(parts: unknown, error?: unknown): Promise<void> {
  if (!Array.isArray(parts)) return
  if (error && !isDatabaseRefusal(error)) return
  const paths = parts
    .filter((part) => part?.type === 'file' && typeof part.path === 'string')
    .map((part) => part.path as string)
  if (paths.length > 0) await removeUnreferencedMirrors(paths)
}
