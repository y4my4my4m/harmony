<template>
  <div class="rules-accept-prompt" role="status" data-testid="rules-accept-prompt">
    <span class="rap-icon" aria-hidden="true"><Icon name="shield-check" :size="18" /></span>
    <p class="rap-text">{{ $t('serverWelcome.promptText', { server: serverName || $t('serverWelcome.thisServer') }) }}</p>
    <button type="button" class="btn btn-primary btn-sm rap-action" data-testid="rules-accept-open" @click="emit('review')">
      {{ $t('serverWelcome.acceptRules') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'

defineProps<{ serverName?: string | null }>()

const emit = defineEmits<{ review: [] }>()
</script>

<style scoped>
.rules-accept-prompt {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 12px 12px;
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 40%, var(--border-primary));
  border-radius: var(--radius-lg);
}

.rap-icon {
  flex-shrink: 0;
  display: flex;
  color: var(--harmony-primary);
}

.rap-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-primary);
}

.rap-action {
  flex-shrink: 0;
}

@media (max-width: 480px) {
  .rules-accept-prompt {
    flex-wrap: wrap;
  }

  .rap-text {
    flex-basis: calc(100% - 40px);
  }

  .rap-action {
    width: 100%;
    justify-content: center;
    min-height: 40px;
  }
}
</style>
