<template>
  <BridgedSourceIcon v-if="useIcon" :source="source" />
  <span v-else class="bridge-source-badge" :class="source" role="img" :aria-label="accessibleLabel" :title="accessibleLabel">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BridgedSourceIcon from '@/components/messages/BridgedSourceIcon.vue'
import { useVisualTheme } from '@/composables/useVisualTheme'
import { bridgePlatformLabel } from '@/utils/messageAuthor'

const props = defineProps<{
  source: string
}>()

const { settings } = useVisualTheme()
const { t } = useI18n()
const accessibleLabel = computed(() => t('bridgeSource.from', { platform: bridgePlatformLabel(props.source) }))

const useIcon = computed(() => settings.value.bridgeSourceBadge !== 'text')

const label = computed(() => props.source.toUpperCase())
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

/* Brand fill, white text: Discord #5865F2 is 4.6:1, Matrix #000000 is 21:1. */
.bridge-source-badge.discord {
  background: #5865F2;
  color: #ffffff;
}

.bridge-source-badge.matrix {
  background: #000000;
  color: #ffffff;
}
</style>
