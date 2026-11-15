<template>
  <div class="blocked-peer-prompt" role="status" data-testid="dm-blocked-peer-prompt">
    <span class="bpp-icon" aria-hidden="true"><Icon name="ban" :size="18" /></span>
    <p class="bpp-text">{{ $t('dm.blockedPeer.text', { name }) }}</p>
    <button
      type="button"
      class="btn btn-secondary btn-sm bpp-action"
      data-testid="dm-blocked-peer-unblock"
      :disabled="busy"
      @click="emit('unblock')"
    >
      {{ $t('dm.blockedPeer.unblock') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'

defineProps<{ name: string; busy?: boolean }>()

const emit = defineEmits<{ unblock: [] }>()
</script>

<style scoped>
/* Layout of RulesAcceptPrompt. */
.blocked-peer-prompt {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 12px 12px;
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
}

.bpp-icon {
  flex-shrink: 0;
  display: flex;
  color: var(--text-muted);
}

.bpp-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-primary);
}

.bpp-action {
  flex-shrink: 0;
}

@media (max-width: 480px) {
  .blocked-peer-prompt {
    flex-wrap: wrap;
  }

  .bpp-text {
    flex-basis: calc(100% - 40px);
  }

  .bpp-action {
    width: 100%;
    justify-content: center;
    min-height: 40px;
  }
}
</style>
