<template>
  <span class="message-author-label" :class="{ truncate }" :style="color ? { color } : undefined">
    <DisplayName
      v-if="profileUserId"
      :user-id="profileUserId"
      :fallback="displayName"
      :truncate="truncate"
    />
    <template v-else>{{ displayName }}</template>
    <BridgeSourceBadge v-if="bridgeSource" :source="bridgeSource" />
  </span>
</template>

<script setup lang="ts">
import BridgeSourceBadge from '@/components/messages/BridgeSourceBadge.vue'
import DisplayName from '@/components/DisplayName.vue'

defineProps<{
  profileUserId: string
  displayName: string
  bridgeSource?: string | null
  truncate?: boolean
  color?: string
}>()
</script>

<style scoped>
.message-author-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}

.message-author-label :deep(.bridge-source-badge),
.message-author-label :deep(.bridged-source-icon) {
  flex-shrink: 0;
}

.message-author-label.truncate {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
