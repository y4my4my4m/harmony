<template>
  <span class="message-author-label" :class="{ truncate }" :style="color ? { color } : undefined">
    <DisplayName
      v-if="profileUserId"
      :user-id="profileUserId"
      :fallback="displayName"
      :truncate="truncate"
    />
    <template v-else>{{ displayName }}</template>
    <BridgedSourceIcon v-if="showBridgeIcon && bridgeSource" :source="bridgeSource" />
  </span>
</template>

<script setup lang="ts">
import BridgedSourceIcon from '@/components/messages/BridgedSourceIcon.vue'
import DisplayName from '@/components/DisplayName.vue'

defineProps<{
  profileUserId: string
  displayName: string
  bridgeSource?: string | null
  showBridgeIcon?: boolean
  truncate?: boolean
  color?: string
}>()
</script>

<style scoped>
.message-author-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.message-author-label.truncate {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
