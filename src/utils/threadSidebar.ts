/** Which threads the channel sidebar lists (20261112700001_thread_sidebar_mode.sql). */
export type ThreadSidebarMode = 'all' | 'joined'

/** Values arrive as plain strings, JSON strings (instance_config) or not at all. */
export function parseThreadSidebarMode(value: unknown): ThreadSidebarMode {
  return value === 'joined' || value === '"joined"' ? 'joined' : 'all'
}

/**
 * all: every thread the account has not left. joined: threads the account is a member of,
 * plus the thread currently open.
 */
export function sidebarThreads<T extends { id: string; is_member?: boolean; left?: boolean }>(
  threads: T[],
  mode: ThreadSidebarMode,
  openThreadId: string | null,
): T[] {
  if (mode === 'joined') {
    return threads.filter(th => th.is_member === true || (openThreadId !== null && th.id === openThreadId))
  }
  return threads.filter(th => !th.left)
}
