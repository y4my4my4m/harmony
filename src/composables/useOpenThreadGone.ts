import { watch, type Ref } from 'vue'
import { threadService, type ThreadWithDetails } from '@/services/ThreadService'
import { isOptimisticThreadId, useThreadsStore } from '@/stores/useThreads'
import { debug } from '@/utils/debug'

/**
 * How the open thread was found gone: 'removed' while open (a manual delete, the deletion of its
 * last message, a thread:delete broadcast), 'missing' when opened (a link or notice naming a
 * deleted thread).
 */
export type ThreadGone = 'removed' | 'missing'

/**
 * Calls `onGone` once per thread when the open thread is deleted. 'removed': its entry leaves the
 * thread index and the server returns no row for it; an entry dropped while its row still exists
 * is put back and the view stays. 'missing': `checkMissing`, called when a view's read found no
 * thread, confirms the row is absent and drops any stale entry. A failed read keeps the view.
 */
export function useOpenThreadGone(
  thread: Ref<ThreadWithDetails | null>,
  onGone: (how: ThreadGone) => void,
): { checkMissing: (id: string) => Promise<void> } {
  const threadsStore = useThreadsStore()
  let reported: string | null = null

  /** False while the row may exist; true once the server returns none. */
  const absent = async (id: string): Promise<boolean> => {
    try {
      const row = await threadService.getThreadRow(id)
      if (row && thread.value?.id === id) thread.value = threadsStore.upsert({ ...thread.value, ...row })
      return !row
    } catch (error) {
      debug.warn('Open thread re-read failed:', error)
      return false
    }
  }

  watch(
    () => {
      const id = thread.value?.id
      return [id, !!(id && threadsStore.byId[id])] as const
    },
    async ([id, present], [previousId, wasPresent]) => {
      if (!id || id !== previousId || !wasPresent || present || isOptimisticThreadId(id)) return
      if (reported === id) return
      if (!(await absent(id)) || thread.value?.id !== id || reported === id) return
      reported = id
      onGone('removed')
    },
  )

  return {
    async checkMissing(id: string) {
      if (isOptimisticThreadId(id) || reported === id) return
      if (!(await absent(id)) || (thread.value && thread.value.id !== id) || reported === id) return
      reported = id
      threadsStore.remove(id)
      threadService.clearThreadCache(id)
      onGone('missing')
    },
  }
}
