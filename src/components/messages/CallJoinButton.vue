<template>
  <button v-if="joinable" class="call-join-btn" @click="join">
    Join call
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { useDMCallJoin } from '@/composables/useDMCallJoin'

const props = defineProps<{
  messageId: string
  conversationId?: string | null
}>()

const { joinConversationCall } = useDMCallJoin()

// Offered while the message's call is tracked (presence-derived); a message
// whose call ended stays inert.
const joinable = computed(() => {
  dmCallSignaling.callStateVersion.value
  if (!props.conversationId) return false
  const call = dmCallSignaling.getActiveCall(props.conversationId)
  if (!call) return false
  return !call.systemMessageId || call.systemMessageId === props.messageId
})

const join = () => {
  if (props.conversationId) void joinConversationCall(props.conversationId)
}
</script>

<style scoped>
.call-join-btn {
  background: var(--success);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-sm);
  padding: 2px 12px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  margin-left: 4px;
  transition: background-color 0.15s;
}

.call-join-btn:hover {
  background: var(--success-hover);
}
</style>
