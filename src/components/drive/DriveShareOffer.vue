<!-- Above the composer: a pasted Drive link that members of the room cannot open, and the
     choice to share the file with them or leave it as it is. -->
<template>
  <div class="drive-offer" role="group" :aria-labelledby="textId" data-testid="drive-share-offer">
    <span class="drive-offer__glyph" aria-hidden="true"><Icon name="lock" :size="16" /></span>
    <p :id="textId" class="drive-offer__text">{{ text }}</p>
    <div class="drive-offer__actions">
      <button
        type="button"
        class="drive-offer__btn drive-offer__btn--primary"
        :disabled="busy"
        data-testid="drive-share-offer-share"
        @mousedown.prevent
        @click="emit('share')"
      >{{ t('drive.offer.share') }}</button>
      <button
        type="button"
        class="drive-offer__btn"
        :disabled="busy"
        data-testid="drive-share-offer-dismiss"
        @mousedown.prevent
        @click="emit('dismiss')"
      >{{ t('drive.offer.sendAnyway') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'

defineProps<{ text: string; busy: boolean }>()
const emit = defineEmits<{ share: []; dismiss: [] }>()

const { t } = useT()
const textId = useId()
</script>

<style scoped>
.drive-offer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0 0 var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--warning) 10%, var(--background-secondary));
  border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
  border-radius: var(--radius-md);
}

.drive-offer__glyph {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--warning);
}

.drive-offer__text {
  flex: 1 1 220px;
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.drive-offer__actions {
  display: flex;
  gap: var(--space-2);
}

.drive-offer__btn {
  min-height: 30px;
  padding: 0 var(--space-3);
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  cursor: pointer;
}

.drive-offer__btn--primary {
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border-color: transparent;
  color: var(--text-on-primary, #fff);
}

.drive-offer__btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

.drive-offer__btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
</style>
