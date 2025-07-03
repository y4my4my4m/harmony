<template>
  <div class="dm-view">
    <DMSidebar @conversation-selected="handleConversationSelected" />
    
    <div class="dm-content">
      <DMChatView 
        v-if="selectedConversationId"
        :conversation-id="selectedConversationId"
      />
      
      <div v-else class="no-conversation-selected">
        <div class="empty-state">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24">
              <path d="M12,2A2,2 0 0,1 14,4C14,4.74 13.6,5.39 13,5.73V7H14A7,7 0 0,1 21,14H22A1,1 0 0,1 23,15V18A1,1 0 0,1 22,19H21V20A2,2 0 0,1 19,22H5A2,2 0 0,1 3,20V19H2A1,1 0 0,1 1,18V15A1,1 0 0,1 2,14H3A7,7 0 0,1 10,7H11V5.73C10.4,5.39 10,4.74 10,4A2,2 0 0,1 12,2M5,9V19H19V9A5,5 0 0,0 14,4H10A5,5 0 0,0 5,9Z" fill="currentColor"/>
            </svg>
          </div>
          <h2>Select a conversation</h2>
          <p>Choose from your existing conversations, or start a new one</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDMStore } from '@/stores/useDM'
import DMSidebar from '@/components/DMSidebar.vue'
import DMChatView from '@/components/DMChatView.vue'

const route = useRoute()
const router = useRouter()
const dmStore = useDMStore()

// State
const selectedConversationId = ref<string | null>(null)

// Methods
const handleConversationSelected = (conversationId: string) => {
  selectedConversationId.value = conversationId
  
  // Update URL to reflect selected conversation
  if (route.params.conversationId !== conversationId) {
    router.push(`/dm/${conversationId}`)
  }
}

// Lifecycle
onMounted(() => {
  // Set initial conversation from route params
  if (route.params.conversationId && typeof route.params.conversationId === 'string') {
    selectedConversationId.value = route.params.conversationId
  }
})

onUnmounted(() => {
  // Clean up DM store when leaving DM view
  dmStore.cleanup()
})
</script>

<style scoped>
.dm-view {
  display: flex;
  height: 100vh;
  background: var(--h-chat, #36393f);
  overflow: hidden;
}

.dm-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.no-conversation-selected {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--h-chat, #36393f);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  color: #72767d;
  max-width: 440px;
  padding: 40px 20px;
}

.empty-icon {
  width: 88px;
  height: 88px;
  margin-bottom: 24px;
  opacity: 0.6;
}

.empty-state h2 {
  margin: 0 0 8px 0;
  font-size: 24px;
  color: #ffffff;
  font-weight: 600;
}

.empty-state p {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  color: #b9bbbe;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .dm-view {
    flex-direction: column;
  }
  
  .empty-state {
    padding: 20px;
  }
  
  .empty-icon {
    width: 64px;
    height: 64px;
    margin-bottom: 16px;
  }
  
  .empty-state h2 {
    font-size: 20px;
  }
  
  .empty-state p {
    font-size: 14px;
  }
}

@media (max-width: 480px) {
  .empty-state {
    padding: 16px;
  }
  
  .empty-icon {
    width: 48px;
    height: 48px;
    margin-bottom: 12px;
  }
  
  .empty-state h2 {
    font-size: 18px;
  }
}
</style>