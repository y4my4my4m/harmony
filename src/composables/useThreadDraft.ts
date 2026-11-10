import { computed, ref, watch } from 'vue'
import { useDraftsStore } from '@/stores/drafts'
import { draftAttachments, moveDraftAttachments } from '@/stores/draftAttachments'

export interface ThreadDraftSource {
  /** Server id of the thread; absent while it is not created. */
  threadId?: string | null
  /** The thread's starter message, or the message a thread is being started on. */
  parentMessageId?: string | null
}

/**
 * Draft of a thread composer: its text in the drafts store, and `key` for MessageInput's
 * draftKey, under which its attachments are kept. A created thread keys on its id,
 * `thread:<id>`; one not created yet on its starter message, `thread:new:<message id>`.
 * A thread whose own draft is empty takes over the draft of its starter message.
 */
export function useThreadDraft(source: () => ThreadDraftSource) {
  const drafts = useDraftsStore()
  const text = ref('')
  const starterKey = (messageId: string) => drafts.makeKey('thread', `new:${messageId}`)

  const key = computed(() => {
    const { threadId, parentMessageId } = source()
    if (threadId) return drafts.makeKey('thread', threadId)
    return parentMessageId ? starterKey(parentMessageId) : null
  })
  const starterDraftKey = computed(() => {
    const { threadId, parentMessageId } = source()
    return threadId && parentMessageId ? starterKey(parentMessageId) : null
  })

  function adopt(to: string, from: string | null): void {
    if (!from || from === to) return
    if (drafts.getDraft(to) || draftAttachments(to).length > 0) return
    const words = drafts.getDraft(from)
    if (words) drafts.saveDraft(to, words)
    drafts.clearDraft(from)
    moveDraftAttachments(from, to)
  }

  // A thread opened by id learns its starter when it loads; text typed by then is kept.
  watch([key, starterDraftKey], ([next, from], [previous]) => {
    const moved = next !== previous
    if (moved && previous && text.value.trim()) drafts.saveDraft(previous, text.value)
    if (!next) {
      text.value = ''
      return
    }
    if (!moved && text.value.trim()) return
    adopt(next, from)
    text.value = drafts.getDraft(next)
  }, { immediate: true })

  watch(text, (value) => {
    if (key.value) drafts.saveDraft(key.value, value)
  })

  return { text, key }
}
