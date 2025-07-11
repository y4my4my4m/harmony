<template>
  <div class="chat-view">
    <!-- Chat Messages -->
    <div class="chat-messages-container">
      <UnifiedContentArea
        mode="chat"
        :chat-messages="chatMessages"
        :is-loading="isLoading"
        :is-d-m="isDM"
        view-type="chat"
        current-view="chat"
        @load-more-messages="fetchMoreMessages"
        @update:is-at-bottom="isAtBottom = $event"
        @send-message="handleSendMessage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useServerChannelStore } from '@/stores/useServerChannel'

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
  sendMessage: [message: any]
}>()

// Stores
const chatStore = useChatStore()
const dmStore = useDMStore()
const serverChannelStore = useServerChannelStore()
const route = useRoute()

// State
const isAtBottom = ref(true)
const isLoading = ref(false)

// Computed
const chatMessages = computed(() => {
  return props.isDM ? dmStore.currentDMMessages : chatStore.messages
})

// Load messages when route changes
const loadMessages = async () => {
  if (props.isDM) {
    const conversationId = route.params.conversationId as string
    if (conversationId) {
      isLoading.value = true
      try {
        await dmStore.loadConversation(conversationId)
      } finally {
        isLoading.value = false
      }
    }
  } else {
    const channelId = route.params.channelId as string
    const serverId = route.params.serverId as string
    
    if (serverId && channelId) {
      isLoading.value = true
      try {
        await chatStore.loadMessages(channelId)
        await serverChannelStore.setCurrentChannel(serverId, channelId)
      } finally {
        isLoading.value = false
      }
    }
  }
}

const fetchMoreMessages = async () => {
  if (props.isDM) {
    await dmStore.loadMoreMessages()
  } else {
    await chatStore.loadMoreMessages()
  }
}

const handleSendMessage = (message: any) => {
  emit('sendMessage', message)
}

// Watch for route changes
watch(() => route.params, loadMessages, { immediate: true })

onMounted(() => {
  loadMessages()
})
</script>

<style scoped>
.chat-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-messages-container {
  flex: 1;
  overflow: hidden;
}
</style>