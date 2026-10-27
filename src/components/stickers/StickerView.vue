<template>
  <figure
    class="sticker-view"
    :class="{ 'sticker-view--gone': gone }"
    data-testid="message-sticker"
    :data-sticker-id="sticker.id"
  >
    <img
      v-if="!gone"
      :src="sticker.url"
      :alt="t('stickers.alt', { name: sticker.name, description: sticker.description })"
      :width="displaySize.width"
      :height="displaySize.height"
      class="sticker-view-img"
      draggable="false"
      loading="lazy"
      @error="failed = true"
    />
    <div
      v-else
      class="sticker-view-placeholder"
      role="img"
      :aria-label="t('stickers.goneLabel', { name: sticker.name, description: sticker.description })"
      data-testid="message-sticker-gone"
    >
      <Icon name="image-off" :size="22" aria-hidden="true" />
      <span class="sticker-view-gone-text">{{ removed ? t('stickers.removed') : t('stickers.unavailable') }}</span>
    </div>
  </figure>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import type { StickerContent } from '@/types'
import { useStickersStore } from '@/stores/useStickers'

/** Largest side a sticker is drawn at in a message, in CSS px. */
const DISPLAY_SIDE = 160

const props = defineProps<{ sticker: StickerContent }>()
const { t } = useI18n()
const stickers = useStickersStore()
const failed = ref(false)

/** Only this instance's stickers are looked up; another instance's go by their file alone. */
const local = computed(() => !props.sticker.domain)
const removed = computed(() => local.value && stickers.isRemoved(props.sticker.id))
const gone = computed(() => removed.value || failed.value)

const displaySize = computed(() => {
  const w = props.sticker.width ?? DISPLAY_SIDE
  const h = props.sticker.height ?? DISPLAY_SIDE
  const scale = DISPLAY_SIDE / Math.max(w, h, 1)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
})

function check(): void {
  failed.value = false
  if (local.value) stickers.checkPresence(props.sticker.id)
}

onMounted(check)
watch(() => props.sticker.id, check)
</script>

<style scoped>
.sticker-view {
  margin: 4px 0;
  display: inline-block;
  max-width: 160px;
}

/* Drawn at the width and height attributes: the longer side at 160 px. */
.sticker-view-img {
  display: block;
  max-width: 160px;
  max-height: 160px;
  object-fit: contain;
  user-select: none;
}

.sticker-view-placeholder {
  width: 120px;
  height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px dashed var(--border-color, rgba(127, 127, 127, 0.4));
  border-radius: 12px;
  color: var(--text-muted, inherit);
  font-size: 0.8rem;
  text-align: center;
  padding: 8px;
}
</style>
