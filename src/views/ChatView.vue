<template>
  <!-- The call's side chat shows this list while it is open -->
  <CallChatElsewhere v-if="callChatHere" />
  <!-- A remote server closed to this instance: why it is silent, in place of its messages -->
  <div v-else-if="closedServer" class="remote-server-closed" data-testid="remote-server-closed">
    <EmptyState
      icon="globe"
      :title="t('federation.closedBanner.title', { name: closedServer.name })"
      :description="t('federation.closedBanner.body')"
      :action-label="t('server.leaveServer')"
      @action="leaveServer(closedServer.id)"
    />
  </div>
  <!-- Chat Messages -->
  <UnifiedContentArea
    v-else
    mode="chat"
    :chat-messages="chatMessages"
    :is-loading="isLoading"
    :is-d-m="isDM"
    :channel-id="props.isDM ? undefined : (route.params.channelId as string)"
    :conversation-id="props.isDM ? (route.params.conversationId as string) : undefined"
    :channel-name="currentChannelName"
    view-type="chat"
    current-view="chat"
    @load-more-messages="fetchMoreMessages"
    @update:is-at-bottom="isAtBottom = $event"
    @show-all-threads="handleShowAllThreads"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRoute, useRouter } from 'vue-router'
import { takeJumpTarget } from '@/utils/messageJumpQuery'
import { useI18n } from 'vue-i18n'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useLeaveServer } from '@/composables/useLeaveServer'
import { checkRemoteServer, isRemoteServerClosed } from '@/utils/remoteServerStatus'
import { syncRemoteServerCopy } from '@/utils/remoteServerSync'
import CallChatElsewhere from '@/components/voice/CallChatElsewhere.vue'
import { useCallChat } from '@/components/voice/callChat'
import { channelListLoading, loadOlderChannelMessages, loadOlderConversationMessages } from '@/composables/chatPaging'

import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useNotificationStore } from '@/stores/useNotification'

// Props
interface Props {
  currentServer?: any
  currentChannel?: any
  isDM?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isDM: false
})

// Emits
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleVoicePanel: []
  showAllThreads: []
}>()

// Stores
const chatStore = useChatStore()
const dmStore = useDMStore()
const serverChannelStore = useServerChannelStore()
const authStore = useAuthStore()
const route = useRoute()
const router = useRouter()

// State
const isAtBottom = ref(true)
const isLoading = channelListLoading
let fetchAbortController: AbortController | null = null
let lastSeenServerId: string | null = null

// Computed
const chatMessages = computed(() => {
  return props.isDM ? dmStore.currentDMMessages : chatStore.messages
})

// Channel name for placeholder - use the prop passed from ChatLayout
const currentChannelName = computed(() => {
  if (props.isDM) return undefined
  return props.currentChannel?.name
})

const { t } = useI18n()
const { leaveServer } = useLeaveServer()

const routeServer = computed(() => {
  if (props.isDM) return null
  const serverId = route.params.serverId as string | undefined
  if (!serverId) return null
  return serverChannelStore.servers.find(s => s.id === serverId)
    ?? (props.currentServer?.id === serverId ? props.currentServer : null)
})
const closedServer = computed(() => isRemoteServerClosed(routeServer.value?.id) ? routeServer.value : null)
watch(() => [routeServer.value?.id, routeServer.value?.is_local_server], () => {
  void checkRemoteServer(routeServer.value)
  void syncRemoteServerCopy(routeServer.value)
}, { immediate: true })

const callChat = useCallChat()
const callChatHere = computed(() => props.isDM
  ? callChat.hosts({ conversationId: route.params.conversationId as string })
  : callChat.hosts({ channelId: route.params.channelId as string }))

const loadMessages = async () => {
  // Abort any in-flight fetch from a previous channel/conversation
  if (fetchAbortController) {
    fetchAbortController.abort()
  }
  const controller = new AbortController()
  fetchAbortController = controller
  const { signal } = controller

  if (props.isDM) {
    // Clean up channel subscriptions when entering DM view to prevent leaks
    chatStore.unsubscribeFromMessages()
    chatStore.trimCachedChannel()

    const conversationId = route.params.conversationId as string
    if (conversationId) {
      if (dmStore.currentConversationId !== conversationId) {
        dmStore.setCurrentConversation(conversationId)
      }

      if (dmStore.isCacheValid(conversationId)) {
        dmStore.loadCachedMessages(conversationId)
        const userId = authStore.session?.user?.id
        if (userId) {
          dmStore.fetchConversationMessages(conversationId, undefined, signal)
        }
        return
      }
      
      isLoading.value = true
      dmStore.clearDMMessages()
      // The skeleton gets two frames to paint; the load runs alongside them.
      const skeletonPainted = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      try {
        const userId = authStore.session?.user?.id
        if (userId) {
          await dmStore.initializeDMEnvironmentForDirectAccess(userId, conversationId)
          if (signal.aborted) return
          await dmStore.fetchConversationMessages(conversationId, undefined, signal)
        }
        await skeletonPainted
      } catch (e: any) {
        if (e?.message === 'Request aborted' || signal.aborted) return
        throw e
      } finally {
        if (!signal.aborted) isLoading.value = false
      }
    }
  } else {
    // Entering a channel closes the open DM: its subscription goes, and its
    // messages count as unread again.
    if (dmStore.currentConversationId) {
      dmStore.setCurrentConversation(null)
    }

    const channelId = route.params.channelId as string
    const serverId = route.params.serverId as string

    // Server switched but the default channel isn't resolved yet
    // (/chat/:serverId without :channelId): clear immediately, otherwise the
    // previous server's messages stay on screen for the whole channel-list
    // round trip.
    if (serverId && serverId !== lastSeenServerId) {
      if (lastSeenServerId !== null && !chatStore.isMessageCached(channelId || '')) {
        chatStore.clearMessages()
        isLoading.value = true
      }
      lastSeenServerId = serverId
    }

    if (serverId && channelId) {
      dmStore.trimCachedConversation()
      if (serverChannelStore.currentChannelId !== channelId) {
        serverChannelStore.setCurrentChannel(channelId, serverId)
      }

      if (chatStore.isMessageCached(channelId)) {
        chatStore.loadCachedMessages(channelId)
        chatStore.subscribeToMessages(channelId)
        chatStore.fetchMessages(channelId, '', signal)
        isLoading.value = false
        return
      }
      
      isLoading.value = true
      chatStore.clearMessages()
      // The skeleton gets two frames to paint; the load runs alongside them.
      const skeletonPainted = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      try {
        await chatStore.fetchMessages(channelId, '', signal)
        if (signal.aborted) return
        chatStore.subscribeToMessages(channelId)
        await skeletonPainted
      } catch (e: any) {
        if (e?.message === 'Request aborted' || signal.aborted) return
        throw e
      } finally {
        if (!signal.aborted) isLoading.value = false
      }
    }
  }
}

onUnmounted(() => {
  if (fetchAbortController) {
    fetchAbortController.abort()
    fetchAbortController = null
  }
  isLoading.value = false
})

const fetchMoreMessages = async () => {
  debug.log('fetchMoreMessages called, isDM:', props.isDM)
  if (props.isDM) await loadOlderConversationMessages(route.params.conversationId as string)
  else await loadOlderChannelMessages(route.params.channelId as string)
}

const handleShowAllThreads = () => {
  emit('showAllThreads')
}

// Watch for route changes
watch(
  () => [route.params.channelId, route.params.conversationId, route.params.serverId],
  loadMessages,
  { immediate: true }
)

watch(() => route.query.messageId, async () => {
  const target = takeJumpTarget(route, router)
  if (!target) return
  await nextTick()
  await scrollToMessage(target.messageId, target.searchQuery)
}, { immediate: true })

const waitForMessages = async () => {
  if (!isLoading.value) return
  await new Promise<void>((resolve) => {
    const stop = watch(isLoading, (loading) => {
      if (!loading) {
        stop()
        resolve()
      }
    })
  })
}

// The list is virtualized: an off-window row has no element, and offsetTop is relative to
// its virtual row. The stores' jump loads the message when needed; MessageDisplay scrolls to
// its index and highlights it. The first page lands first, since it replaces the list.
const scrollToMessage = async (messageId: string, searchQuery?: string) => {
  await waitForMessages()
  await nextTick()

  let found = false
  if (props.isDM) {
    found = await dmStore.jumpToMessage(messageId)
  } else {
    const channelId = route.params.channelId as string
    if (channelId) found = await chatStore.jumpToMessage(messageId, channelId)
  }
  if (!found) debug.warn(`Could not jump to message: ${messageId}`)

  const notificationStore = useNotificationStore()
  const notification = notificationStore.notifications.find(n =>
    (n.data?.message?.id === messageId || n.data?.message_id === messageId) && !n.is_read
  )
  if (notification) {
    await notificationStore.markAsRead(notification.id)
  }

  if (found && searchQuery) {
    // MessageDisplay scrolls 100 ms after the jump; the row renders once it is in view.
    await new Promise(resolve => setTimeout(resolve, 400))
    const messageElement = document.getElementById(`message-${messageId}`)
    if (messageElement) highlightSearchText(messageElement, searchQuery)
  }
}

// Function to highlight search text within message content
const highlightSearchText = (messageElement: HTMLElement, query: string) => {
  const contentElements = messageElement.querySelectorAll('.unified-content .text-content')
  const searchTerms = query.trim().split(/\s+/).filter(term => term.length > 0)
  
  contentElements.forEach(element => {
    searchTerms.forEach(term => {
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null
      )
      
      const textNodes: Text[] = []
      let node
      while ((node = walker.nextNode())) {
        textNodes.push(node as Text)
      }
      
      textNodes.forEach(textNode => {
        const text = textNode.textContent || ''
        const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
        if (regex.test(text)) {
          const parent = textNode.parentNode
          if (parent && parent.nodeName !== 'MARK') {
            // Build the highlight wrapper using DOM APIs rather than
            // `innerHTML = text.replace(...)`. `textNode.textContent` is the
            // DECODED text - if the message renderer escaped `<style>foo`
            // into `&lt;style&gt;foo`, the DOM has `<style>foo` as text
            // content here, and assigning that back via innerHTML would
            // re-parse it as a real <style> tag and re-introduce the XSS the
            // message renderer defends against.
            const wrapper = document.createElement('span')
            let lastIndex = 0
            let match: RegExpExecArray | null
            regex.lastIndex = 0
            while ((match = regex.exec(text)) !== null) {
              if (match.index > lastIndex) {
                wrapper.appendChild(
                  document.createTextNode(text.slice(lastIndex, match.index)),
                )
              }
              const mark = document.createElement('mark')
              mark.className = 'search-highlight'
              mark.textContent = match[0]
              wrapper.appendChild(mark)
              lastIndex = match.index + match[0].length
              if (regex.lastIndex === match.index) regex.lastIndex++
            }
            if (lastIndex < text.length) {
              wrapper.appendChild(document.createTextNode(text.slice(lastIndex)))
            }
            parent.replaceChild(wrapper, textNode)

            // Remove highlight after 5 seconds
            setTimeout(() => {
              const marks = wrapper.querySelectorAll('mark.search-highlight')
              marks.forEach(mark => {
                const text = mark.textContent || ''
                const textNode = document.createTextNode(text)
                mark.parentNode?.replaceChild(textNode, mark)
              })
              if (wrapper.parentNode && wrapper.textContent) {
                const textNode = document.createTextNode(wrapper.textContent)
                wrapper.parentNode.replaceChild(textNode, wrapper)
              }
            }, 5000)
          }
        }
      })
    })
  })
}

// Initial load runs through the watcher's `immediate: true`; no onMounted.
</script>

<style scoped>
.remote-server-closed {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow-y: auto;
}

.chat-view {
  height: 100%;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}



.chat-messages-container {
  flex: 1;
  overflow: hidden;
}

/* Mobile styles */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
    min-width: 40px;
    min-height: 40px;
    align-items: center;
    justify-content: center;
  }
}
</style>