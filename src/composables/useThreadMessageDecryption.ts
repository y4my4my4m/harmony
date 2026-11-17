import { onScopeDispose, watch, type Ref } from 'vue'
import type { Message } from '@/types'
import { threadService } from '@/services/ThreadService'
import { processMessageDecryption } from '@/utils/messageDecryption'
import { debug } from '@/utils/debug'

/** Thread views own their rows rather than using the channel store's decryption lifecycle. */
export function useThreadMessageDecryption(
  messages: Ref<Message[]>,
  threadId: () => string | undefined
) {
  let disposed = false

  const decrypt = async () => {
    const id = threadId()
    const pending = messages.value.filter((message) => message.encrypted && !message.decrypted)
    if (!id || !pending.length) return

    try {
      const decrypted = await processMessageDecryption(pending)
      if (disposed || threadId() !== id) return
      decrypted.forEach((message, index) => {
        const original = pending[index]
        // A send, edit, delete or navigation may have replaced the row while keys were loading.
        const at = messages.value.indexOf(original)
        if (
          at === -1 ||
          (!message.decrypted &&
            message.decryption_unrecoverable === original.decryption_unrecoverable)
        )
          return
        messages.value[at] = message
        threadService.updateMessageInCache(id, message.id, message)
      })
    } catch (error) {
      debug.warn('Failed to decrypt thread messages:', error)
    }
  }

  // Includes history, send responses and realtime inserts/edits, in both thread views.
  watch(
    () => messages.value.filter((message) => message.encrypted && !message.decrypted),
    decrypt,
    { immediate: true }
  )
  window.addEventListener('megolm-key-received', decrypt)
  onScopeDispose(() => {
    disposed = true
    window.removeEventListener('megolm-key-received', decrypt)
  })
}
