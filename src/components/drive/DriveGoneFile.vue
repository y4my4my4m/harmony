<!-- A message attachment whose Drive file expired, was deleted by its owner or removed by
     the instance moderators. -->
<template>
  <div class="drive-gone" :class="{ 'drive-gone--compact': compact }" role="note" data-testid="drive-gone-file">
    <Icon :name="reason === 'expired' ? 'hourglass' : 'trash-2'" :size="compact ? 18 : 20" class="drive-gone__icon" />
    <div class="drive-gone__text">
      <span class="drive-gone__title">{{ title }}</span>
      <span v-if="name && !compact" class="drive-gone__name">{{ name }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import type { GoneReason } from '@/services/privateMedia'

const props = withDefaults(defineProps<{
  reason: GoneReason
  name?: string | null
  fileType?: string | null
  compact?: boolean
}>(), { name: null, fileType: null, compact: false })

const { t } = useT()

const title = computed(() => {
  if (props.reason === 'expired') return t('drive.gone.expired')
  if (props.reason === 'removed') return t('drive.gone.removed')
  if (props.reason === 'trashed') return t('drive.gone.trashed')
  return t('drive.gone.deleted')
})
</script>

<style scoped>
.drive-gone {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  max-width: min(420px, 100%);
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
}

.drive-gone--compact {
  width: 100%;
  height: 100%;
  justify-content: center;
  border-radius: inherit;
}

.drive-gone__icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.drive-gone__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.drive-gone__title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}

.drive-gone__name {
  overflow: hidden;
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}
</style>
