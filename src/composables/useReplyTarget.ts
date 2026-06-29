import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useMessageAuthorPresentation } from '@/composables/useMessageAuthorPresentation'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { messagePartsToPlainText } from '@/utils/messageContentUtils'
import type { Message } from '@/types'

type ReplyContext = {
  channelId?: string | null
  conversationId?: string | null
  serverId?: string | null
}

function findInList(messages: Message[] | undefined, id: string): Message | null {
  return messages?.find(m => m.id === id) ?? null
}

export function useReplyTarget(
  replyMessageId: MaybeRefOrGetter<string | undefined>,
  context: MaybeRefOrGetter<ReplyContext> = {},
) {
  const chatStore = useChatStore()
  const dmStore = useDMStore()
  const replyMessage = shallowRef<Message | null>(null)
  const isLoading = shallowRef(false)
  let resolveGeneration = 0

  const resolve = async () => {
    const id = toValue(replyMessageId)
    if (!id) {
      replyMessage.value = null
      isLoading.value = false
      return
    }

    const generation = ++resolveGeneration
    isLoading.value = true

    const ctx = toValue(context)
    let msg: Message | null = null

    if (ctx.channelId) {
      msg = findInList(chatStore.messages, id)
        ?? chatStore.replyMessageCache.get(id)
        ?? null
      if (!msg) msg = await chatStore.fetchReplyMessage(id)
    } else if (ctx.conversationId) {
      msg = findInList(dmStore.currentDMMessages, id)
        ?? dmStore.replyMessageCache.get(id)
        ?? null
      if (!msg) msg = await dmStore.fetchReplyMessage(id)
    }

    if (generation !== resolveGeneration) return
    replyMessage.value = msg
    isLoading.value = false
  }

  watch(
    [
      () => toValue(replyMessageId),
      () => toValue(context),
      () => chatStore.messages,
      () => dmStore.currentDMMessages,
    ],
    () => { void resolve() },
    { immediate: true },
  )

  const author = useMessageAuthorPresentation(replyMessage, {
    serverId: () => toValue(context).serverId,
  })

  const previewText = computed(() => {
    if (isLoading.value) return 'Loading...'
    if (!replyMessage.value) return 'Deleted message'
    return messagePartsToPlainText(replyMessage.value.content)
  })

  const authorLabel = computed(() => {
    if (isLoading.value) return '...'
    return author.displayName.value
  })

  return {
    replyMessage,
    isLoading,
    previewText,
    authorLabel,
    ...author,
  }
}
