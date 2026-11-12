<template>
  <BridgedSourceIcon v-if="useIcon" :source="source" />
  <span v-else class="bridge-source-badge" :class="source" role="img" :aria-label="accessibleLabel" :title="accessibleLabel">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BridgedSourceIcon from '@/components/messages/BridgedSourceIcon.vue'
import { useVisualTheme } from '@/composables/useVisualTheme'

const props = defineProps<{
  source: string
}>()

const { settings } = useVisualTheme()
const { t } = useI18n()
const accessibleLabel = computed(() => t('bridgeSource.from', { platform: props.source === 'matrix' ? 'Matrix' : props.source === 'discord' ? 'Discord' : props.source }))

const useIcon = computed(() => settings.value.bridgeSourceBadge !== 'text')

const label = computed(() => {
  if (props.source === 'discord') return 'DISCORD'
  return props.source.toUpperCase()
})
</script>

<style scoped>
.bridge-source-badge {
  display: inline-block;
  background: var(--harmony-primary);
  color: var(--text-primary);
  font-size: 0.625rem;
  font-weight: 600;
  padding: 0.125rem 0.25rem;
  border-radius: 0.1875rem;
  vertical-align: middle;
  margin-left: 0.25rem;
}

.bridge-source-badge.discord {
  background: #5865F2;
  color: #ffffff;
}
.bridge-source-badge.matrix {
  background: var(--background-tertiary);
  color: var(--text-primary);
}
</style>
