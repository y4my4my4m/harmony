import { supabase } from '../config/supabase.js'
import { bridgeAvatarFolder } from '../utils/bridgeAvatar.js'

// Objects per storage list and per storage remove.
const LIST_PAGE = 1000
const REMOVE_BATCH = 500
// (bot, server) pairs per pass.
const PURGE_PAIRS = 50
const PURGE_EVERY_MS = 5 * 60_000

let purging = false

/**
 * Removes the avatars of Matrix bridges that are gone: the (bot, server) pairs bridge_avatar_unbound
 * lists, no binding for an hour. The list is the database's and loses a pair with its last object, so
 * a pass that stops early, a restart or a longer folder is finished by the next one. Returns the
 * number of objects removed; 0 while a pass runs.
 */
export async function purgeUnboundAvatars(): Promise<number> {
  if (purging) return 0
  purging = true
  let removed = 0
  try {
    const { data, error } = await supabase.rpc('bridge_avatar_unbound', { p_limit: PURGE_PAIRS })
    if (error) throw new Error(`bridge_avatar_unbound failed: ${error.message}`)
    const bucket = supabase.storage.from('avatars')
    for (const pair of (Array.isArray(data) ? data : []) as Array<{ bot_id: string; server_id: string }>) {
      const folder = bridgeAvatarFolder(pair.bot_id, pair.server_id)
      try {
        const { data: objects, error: listError } = await bucket.list(folder, { limit: LIST_PAGE })
        if (listError || !Array.isArray(objects)) throw new Error(listError?.message ?? 'no listing')
        const paths = objects.map(object => `${folder}/${object.name}`)
        for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
          const { data: gone, error: removeError } = await bucket.remove(paths.slice(i, i + REMOVE_BATCH))
          if (removeError) throw new Error(removeError.message)
          removed += gone?.length ?? 0
        }
      } catch (error: any) {
        console.error(`Removing ${folder} failed:`, error?.message || error)
      }
    }
  } catch (error: any) {
    console.error('Bridge avatar purge failed:', error?.message || error)
  } finally {
    purging = false
  }
  if (removed > 0) console.log(`Bridge avatar purge removed ${removed} object(s)`)
  return removed
}

/** purgeUnboundAvatars now and every PURGE_EVERY_MS; the returned function stops it. */
export function startAvatarPurge(): () => void {
  void purgeUnboundAvatars()
  const timer = setInterval(() => { void purgeUnboundAvatars() }, PURGE_EVERY_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
