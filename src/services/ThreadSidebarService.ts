/**
 * Thread sidebar visibility (20261112700001_thread_sidebar_mode.sql): which threads the channel
 * sidebar lists. The mode is per server, with an instance default.
 */
import { ref, watch, type Ref } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'
import { parseThreadSidebarMode, type ThreadSidebarMode } from '@/utils/threadSidebar'

/** instance_config key holding the default for servers that have not chosen. */
export const THREAD_SIDEBAR_DEFAULT_KEY = 'thread_sidebar_default'

export interface ThreadSidebarState {
  /** Effective mode. */
  mode: ThreadSidebarMode
  /** The server's own choice; null follows instance_default. */
  server_value: ThreadSidebarMode | null
  instance_default: ThreadSidebarMode
}

function unwrap(result: { data: unknown; error: unknown }): ThreadSidebarState {
  if (result.error) throw result.error
  return result.data as ThreadSidebarState
}

/** Requires MANAGE_SERVER on a local server. */
export async function getServerThreadSidebar(serverId: string): Promise<ThreadSidebarState> {
  return unwrap(await supabase.rpc('get_server_thread_sidebar', { p_server_id: serverId }))
}

/** Requires MANAGE_SERVER on a local server. null returns the server to the instance default. */
export async function setServerThreadSidebar(
  serverId: string,
  mode: ThreadSidebarMode | null,
): Promise<ThreadSidebarState> {
  return unwrap(await supabase.rpc('set_server_thread_sidebar', {
    p_server_id: serverId,
    p_mode: mode,
  }))
}

/** Readable by instance admins only (instance_config RLS). */
export async function getInstanceThreadSidebarDefault(): Promise<ThreadSidebarMode> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', THREAD_SIDEBAR_DEFAULT_KEY)
    .maybeSingle()
  if (error) throw error
  return parseThreadSidebarMode(data?.config_value)
}

/** set_instance_config requires an instance admin. */
export async function setInstanceThreadSidebarDefault(mode: ThreadSidebarMode): Promise<void> {
  const { data, error } = await supabase.rpc('set_instance_config', {
    p_key: THREAD_SIDEBAR_DEFAULT_KEY,
    p_value: mode,
    p_description: 'Which threads the channel sidebar lists for servers whose server_settings.thread_sidebar is NULL',
  })
  if (error) throw error
  if (data === false) throw new Error('set_instance_config refused the thread sidebar default')
}

/** Effective mode for the signed-in member; null when the lookup fails. */
export async function getThreadSidebarMode(serverId: string): Promise<ThreadSidebarMode | null> {
  try {
    const { data, error } = await supabase.rpc('server_thread_sidebar_mode', { p_server_id: serverId })
    if (error) throw error
    return parseThreadSidebarMode(data)
  } catch (error) {
    debug.error('Failed to look up the thread sidebar mode:', error)
    return null
  }
}

const storageKey = (serverId: string) => `harmony.threadSidebarMode.${serverId}`

function readRemembered(serverId: string): ThreadSidebarMode {
  try {
    return parseThreadSidebarMode(userStorage.getItem(storageKey(serverId)))
  } catch {
    return 'all'
  }
}

function remember(serverId: string, mode: ThreadSidebarMode): void {
  try {
    userStorage.setItem(storageKey(serverId), mode)
  } catch {
    /* storage unavailable: the mode just is not remembered */
  }
}

// Modes learned this session, so a save applies to every open sidebar immediately.
const live = ref<Record<string, ThreadSidebarMode>>({})

/** Apply a mode right away (after a save) and remember it on this device. */
export function setCached(serverId: string, mode: ThreadSidebarMode): void {
  live.value = { ...live.value, [serverId]: mode }
  remember(serverId, mode)
}

/**
 * The server's thread sidebar mode. Starts from the mode this device last knew, then looks it
 * up; a failed lookup keeps the remembered mode. Remote servers are not looked up.
 */
export function useThreadSidebarMode(serverId: Ref<string | null>, isLocal: Ref<boolean>) {
  const mode = ref<ThreadSidebarMode>('all')

  watch(
    () => live.value[serverId.value ?? ''],
    (value) => { if (value) mode.value = value },
  )

  watch(serverId, async (id) => {
    if (!id) {
      mode.value = 'all'
      return
    }
    mode.value = live.value[id] ?? readRemembered(id)
    if (!isLocal.value) return
    const result = await getThreadSidebarMode(id)
    if (result === null || serverId.value !== id) return
    mode.value = result
    setCached(id, result)
  }, { immediate: true })

  return { mode }
}
