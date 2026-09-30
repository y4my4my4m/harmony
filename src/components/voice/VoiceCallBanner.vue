<template>
  <div v-if="kind" class="vcb" :class="[`vcb--${kind}`, { compact }]" role="status" aria-live="polite">
    <template v-if="kind === 'reconnecting'">
      <span class="vcb-spinner" aria-hidden="true" />
      <span class="vcb-text">{{ t('voice.reconnecting') }}</span>
    </template>
    <template v-else>
      <Icon name="volume-x" :size="16" class="vcb-icon" />
      <span class="vcb-text">{{ t('voice.audioBlocked') }}</span>
      <button type="button" class="vcb-btn" @click.stop="voiceStore.unlockAudio()">
        {{ t('voice.enableAudio') }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import Icon from '@/components/common/Icon.vue';

// Call-level problems the user can see or fix: a reconnecting link, or
// audio the browser refused to autoplay (fixed by one click).
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();

const kind = computed<'reconnecting' | 'blocked' | null>(() => {
  if (!voiceStore.isConnected) return null;
  if (voiceStore.connectionState === 'reconnecting') return 'reconnecting';
  if (voiceStore.audioPlaybackBlocked) return 'blocked';
  return null;
});
</script>

<style scoped>
.vcb {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--warning) 18%, var(--background-floating));
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
}

.vcb--blocked {
  background: color-mix(in srgb, var(--harmony-primary) 16%, var(--background-floating));
  border-color: color-mix(in srgb, var(--harmony-primary) 45%, transparent);
}

.vcb.compact {
  padding: 6px 10px;
  font-size: var(--font-size-xs);
}

.vcb-text {
  flex: 1;
  min-width: 0;
}

.vcb-icon {
  color: var(--harmony-primary);
  flex-shrink: 0;
}

.vcb-btn {
  flex-shrink: 0;
  padding: 5px 12px;
  border: none;
  border-radius: var(--radius-base);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.vcb-btn:hover {
  background: var(--harmony-primary-hover);
}

.vcb-btn:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}

.vcb-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, var(--warning) 35%, transparent);
  border-top-color: var(--warning);
  border-radius: 50%;
  animation: vcb-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes vcb-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .vcb-spinner { animation-duration: 2.4s; }
}

:root[data-reduce-motion="true"] .vcb-spinner {
  animation-duration: 2.4s;
}
</style>
