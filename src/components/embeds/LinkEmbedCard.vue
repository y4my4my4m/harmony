<template>
  <article
    class="link-embed-card"
    :class="{
      'link-embed-card--has-image': !!payload.image && variant !== 'compact',
      'link-embed-card--compact': variant === 'compact',
      'link-embed-card--thumbnail': variant === 'thumbnail',
    }"
  >
    <!-- Big thumbnail: only the default variant. The compact variant is
         used by MonyPost when the same URL is already represented by an
         inline rich embed (e.g. YouTube iframe), so rendering the same
         thumbnail again would be visually redundant. The thumbnail variant
         still renders the image but at a small fixed size beside the
         text. -->
    <div v-if="payload.image && variant !== 'compact'" class="link-embed-card__media">
      <img
        :src="payload.image"
        :alt="payload.title || payload.siteName || 'Link preview image'"
        loading="lazy"
        @load="handleImageLoad"
      />
    </div>
    <div class="link-embed-card__body">
      <div class="link-embed-card__meta">
        <img v-if="payload.icon" :src="payload.icon" alt="" class="link-embed-card__icon" />
        <span class="link-embed-card__site">{{ displaySiteName }}</span>
      </div>
      <h5 class="link-embed-card__title">
        {{ payload.title || payload.url }}
      </h5>
      <p v-if="payload.description" class="link-embed-card__description">
        {{ payload.description }}
      </p>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EmbedPayload } from '@/types';

const props = withDefaults(
  defineProps<{
    payload: EmbedPayload;
    /**
     * 'default'   → full card with large thumbnail (top on mobile, left on
     *               desktop) + body. Used when the link card is the only
     *               visual representation of the URL.
     * 'compact'   → slim caption row (no thumbnail), used as a low-visual-
     *               weight metadata strip beneath an inline rich embed
     *               (e.g. YouTube iframe) so we don't double-render the
     *               same URL's preview.
     * 'thumbnail' → fixed-size horizontal card (small thumbnail on left,
     *               one-line title + one-line description). Used when the
     *               post ALSO has a media attachment - the attachment is
     *               already the dominant visual, so the link card just
     *               adds the title/site context without duplicating the
     *               image size. Mirrors Mastodon/Misskey's "small card
     *               beneath the photo" layout.
     */
    variant?: 'default' | 'compact' | 'thumbnail';
  }>(),
  { variant: 'default' }
);

const emit = defineEmits<{
  'load': [];
}>();

// "Loaded immediately" for the no-image case AND for the compact variant
// (which never renders the thumbnail), so the parent's load listener fires
// without waiting on an image that will never paint.
const imageLoaded = ref(!props.payload.image || props.variant === 'compact');

const displaySiteName = computed(() => {
  if (props.payload.siteName) {
    return props.payload.siteName;
  }
  try {
    const url = new URL(props.payload.url);
    return url.hostname.replace(/^www\./i, '');
  } catch {
    return props.payload.provider;
  }
});

const handleImageLoad = () => {
  if (!imageLoaded.value) {
    imageLoaded.value = true;
    emit('load');
  }
};

onMounted(() => {
  // Emit immediately when no image will paint (no payload image, or the
  // compact variant which intentionally hides it).
  if (!props.payload.image || props.variant === 'compact') {
    emit('load');
  }
});
</script>

