<template>
  <span
    class="voice-encryption-badge"
    :class="[{ encrypted }, size]"
    :title="encrypted
      ? 'End-to-end encrypted — media is encrypted before it reaches the server'
      : 'Not end-to-end encrypted — media is secured in transit (DTLS-SRTP) but the server can access it'"
  >
    <Icon :name="encrypted ? 'shield-check' : 'shield-off'" />
    <span v-if="showLabel" class="voice-encryption-label">{{ encrypted ? 'E2EE' : 'Not E2EE' }}</span>
  </span>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue';

withDefaults(
  defineProps<{
    encrypted: boolean;
    /** Icon sizing preset. */
    size?: 'sm' | 'md';
    /** Show a short text label next to the shield. */
    showLabel?: boolean;
  }>(),
  { size: 'sm', showLabel: false }
);
</script>

<style scoped>
.voice-encryption-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: var(--text-muted, #9ca3af);
  opacity: 0.7;
}

.voice-encryption-badge.encrypted {
  color: #57f287;
  opacity: 1;
}

.voice-encryption-badge.sm :deep(svg) {
  width: 12px;
  height: 12px;
}

.voice-encryption-badge.md :deep(svg) {
  width: 16px;
  height: 16px;
}

.voice-encryption-label {
  font-size: 0.6875rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
