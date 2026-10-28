<!--
  "Keep photo details" of one picked photo or video: a location chip when the file carries GPS,
  and the checkbox choosing whether its metadata goes up with it (utils/stripMetadata.ts).
  Renders nothing for a file without metadata, or before it has been read. `locked`: the
  original bytes are gone (a restored draft whose upload was stripped); the box cannot be ticked.
-->
<template>
  <div v-if="details?.details" class="photo-details" data-testid="photo-details">
    <span
      v-if="details.location"
      :id="chipId"
      class="photo-details-chip"
      :class="keep ? 'is-kept' : 'is-removed'"
      data-testid="photo-location-chip"
    >
      <Icon :name="keep ? 'map-pin' : 'map-pin-off'" :size="12" />
      {{ keep ? t('photoDetails.locationKept') : t('photoDetails.locationRemoved') }}
    </span>
    <label class="photo-details-keep">
      <input
        type="checkbox"
        :checked="keep"
        :disabled="disabled || locked"
        :aria-describedby="describedBy"
        data-testid="keep-photo-details"
        @change="emit('update:keep', ($event.target as HTMLInputElement).checked)"
      />
      <span>{{ t('photoDetails.keep') }}</span>
    </label>
    <span v-if="locked" :id="noteId" class="photo-details-note" data-testid="photo-details-gone">
      {{ t('photoDetails.originalGone') }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'
import type { MediaDetails } from '@/utils/stripMetadata'

const props = defineProps<{
  details?: Pick<MediaDetails, 'location' | 'details'> | null
  keep: boolean
  disabled?: boolean
  locked?: boolean
  /** Id of the element naming the file. */
  describedby?: string
}>()

const emit = defineEmits<{ (e: 'update:keep', keep: boolean): void }>()
const { t } = useT()
const chipId = uid('photo-location')
const noteId = uid('photo-details-note')

const describedBy = computed(() => {
  const ids = [props.describedby, props.details?.location ? chipId : null, props.locked ? noteId : null].filter(Boolean)
  return ids.length ? ids.join(' ') : undefined
})
</script>

<style scoped>
.photo-details {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.3;
}

.photo-details-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  font-weight: 600;
  white-space: nowrap;
}

.photo-details-chip.is-removed {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--text-primary);
}

.photo-details-chip.is-kept {
  background: color-mix(in srgb, var(--warning) 22%, transparent);
  color: var(--text-primary);
}

.photo-details-keep {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}

.photo-details-keep input {
  margin: 0;
  width: 14px;
  height: 14px;
  accent-color: var(--harmony-primary);
  cursor: pointer;
}

.photo-details-note {
  flex-basis: 100%;
  color: var(--text-secondary);
  font-size: 11px;
}

.photo-details-keep input:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
