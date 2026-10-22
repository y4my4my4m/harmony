<!-- The app's one media viewer: renders the request openLightbox (composables/useLightbox) made. -->
<template>
  <MediaLightbox
    v-if="request"
    :key="request.id"
    v-model:index="index"
    :visible="true"
    :imgs="items"
    :origin="request.options.origin ?? null"
    :download="request.options.download !== false"
    :to="target"
    @hide="close"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MediaLightbox, { type LightboxItem } from '@/components/common/MediaLightbox.vue'
import { useLightbox, type LightboxMedia } from '@/composables/useLightbox'

const { request, close } = useLightbox()
const index = ref(0)

watch(request, (next) => {
  if (next) index.value = next.index
}, { immediate: true, flush: 'sync' })

function toItem(media: LightboxMedia): LightboxItem {
  const common = { src: media.url, alt: media.alt, name: media.name }
  if (media.type === 'video') return { ...common, type: 'video', poster: media.poster, isGifv: media.loop === true }
  if (media.type === 'audio') return { ...common, type: 'audio', poster: media.poster }
  if (media.type === 'embed') return { ...common, type: 'embed', poster: media.poster }
  return { ...common, type: 'image' }
}

const items = computed(() => (request.value?.items ?? []).map(toItem))

const target = computed(() => {
  const option = request.value?.options.target
  const el = typeof option === 'function' ? option() : option
  return el?.isConnected ? el : undefined
})
</script>
