<!-- BannerImage - Cover image filling its positioned parent; falls back from a render URL to the stored object -->
<template>
  <img
    v-if="current"
    v-bind="$attrs"
    :src="current"
    :alt="alt"
    class="banner-image"
    :class="{ 'banner-image--expandable': fullSize }"
    :width="width"
    :height="height"
    :loading="eager ? 'eager' : 'lazy'"
    decoding="async"
    draggable="false"
    :role="fullSize ? 'button' : undefined"
    :tabindex="fullSize ? 0 : undefined"
    :aria-label="fullSize ? t('files.viewFullSize') : undefined"
    @error="onError"
    @click="openFullSize"
    @keydown.enter.prevent="openFullSize"
    @keydown.space.prevent="openFullSize"
  />
  <MediaLightbox v-if="lightboxOpen && fullSize" :visible="true" :imgs="[fullSize]" @hide="lightboxOpen = false" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MediaLightbox from '@/components/common/MediaLightbox.vue'

interface Props {
  /** Display URL, normally a render URL. */
  src: string | null
  /** Untransformed object URL: tried once when `src` fails, and opened full size. */
  fallbackSrc?: string | null
  alt?: string
  /** Intrinsic size hints; CSS sizes the element to its parent. */
  width?: number
  height?: number
  eager?: boolean
  /** Click opens the stored object in MediaLightbox. */
  expandable?: boolean
}

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<Props>(), {
  fallbackSrc: null,
  alt: '',
  width: 1280,
  height: 400,
  eager: false,
  expandable: false,
})

const emit = defineEmits<{ failed: [] }>()

const { t } = useI18n()

const attempt = ref(0)
const lightboxOpen = ref(false)

const candidates = computed(() =>
  [props.src, props.fallbackSrc].filter((u, i, all): u is string => !!u && all.indexOf(u) === i),
)

const current = computed(() => candidates.value[attempt.value] ?? null)

const fullSize = computed(() => (props.expandable ? props.fallbackSrc || props.src : null))

watch(candidates, () => { attempt.value = 0 })

function onError() {
  attempt.value += 1
  if (!current.value) emit('failed')
}

function openFullSize(event: Event) {
  if (!fullSize.value) return
  event.stopPropagation()
  lightboxOpen.value = true
}
</script>

<style scoped>
.banner-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
}

.banner-image--expandable {
  cursor: zoom-in;
}

.banner-image--expandable:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}
</style>
