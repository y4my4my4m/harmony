import { supabase } from '../config/supabase.js'

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
