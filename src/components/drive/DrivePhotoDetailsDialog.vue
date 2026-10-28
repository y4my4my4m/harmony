<!-- Before a Drive upload of photos or videos that carry metadata: "Keep photo details" per file. -->
<template>
  <UnifiedModal
    :model-value="true"
    :title="t('photoDetails.drive.title')"
    size="sm"
    :actions="[
      { key: 'cancel', label: t('common.cancel'), variant: 'secondary', handler: () => emit('cancel') },
      { key: 'upload', label: t('photoDetails.drive.upload'), variant: 'primary', handler: () => emit('confirm') },
    ]"
    @update:model-value="(open) => !open && emit('cancel')"
  >
    <p class="drive-photo-details__intro">{{ t('photoDetails.drive.intro') }}</p>
    <ul class="drive-photo-details__list" data-testid="drive-photo-details">
      <li v-for="(item, index) in items" :key="index" class="drive-photo-details__item">
        <span :id="`${idBase}-${index}`" class="drive-photo-details__name">{{ item.file.name }}</span>
        <PhotoDetailsControl
          :details="item.details"
          :keep="item.keep"
          :describedby="`${idBase}-${index}`"
          @update:keep="(keep) => emit('set-keep', index, keep)"
        />
      </li>
    </ul>
  </UnifiedModal>
</template>

<script setup lang="ts">
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import PhotoDetailsControl from '@/components/common/PhotoDetailsControl.vue'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'
import type { MediaDetails } from '@/utils/stripMetadata'

export interface DrivePhotoDetailsItem {
  file: File
  details: MediaDetails
  keep: boolean
}

defineProps<{ items: DrivePhotoDetailsItem[] }>()
const emit = defineEmits<{ confirm: []; cancel: []; 'set-keep': [index: number, keep: boolean] }>()
const { t } = useT()
const idBase = uid('drive-photo-details')
</script>

<style scoped>
.drive-photo-details__intro {
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.drive-photo-details__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: calc(50 * var(--app-vh));
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.drive-photo-details__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
}

.drive-photo-details__name {
  overflow: hidden;
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold, 600);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
