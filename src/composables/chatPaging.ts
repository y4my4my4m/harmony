import { ref } from 'vue'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { debug } from '@/utils/debug'

/**
 * First-page loading of the routed ChatView and DMView. Shared with the call's
 * side chat, which shows the routed list (components/voice/callChat.ts).
 */
export const channelListLoading = ref(false)
export const conversationListLoading = ref(false)

/** The page before the oldest loaded message of the routed channel. */
export async function loadOlderChannelMessages(channelId: string | undefined): Promise<void> {
  const chatStore = useChatStore()
  if (chatStore.allMessagesLoaded) {
    debug.log('All messages already loaded, not fetching more')
    return
  }
  if (chatStore.loadingOlderMessages) {
    debug.log('Already loading older messages, skipping')
    return
  }
  if (!channelId || chatStore.messages.length === 0) {
    debug.log('Cannot fetch messages: no channel or no messages yet')
    return
  }
  const oldestMessage = chatStore.messages[0]
  debug.log('Fetching older messages before message:', oldestMessage.id, oldestMessage.created_at)
  await chatStore.fetchMessages(channelId, oldestMessage.id)
}

/** The page before the oldest loaded message of the routed conversation. */
export async function loadOlderConversationMessages(conversationId: string | undefined): Promise<void> {
  const dmStore = useDMStore()
  if (!conversationId || dmStore.currentDMMessages.length === 0) {
    debug.log('Cannot fetch DM messages: no conversation or no messages yet')
    return
  }
  const oldestMessage = dmStore.currentDMMessages[0]
  debug.log('Fetching older DM messages before:', oldestMessage.id)
  await dmStore.fetchConversationMessages(conversationId, oldestMessage.id)
}
