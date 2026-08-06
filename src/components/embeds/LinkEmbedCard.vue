<template>
  <article
    class="link-embed-card"
    :class="{
      'link-embed-card--has-image': !!payload.image && variant !== 'compact',
      'link-embed-card--compact': variant === 'compact',
      'link-embed-card--thumbnail': variant === 'thumbnail',
      'link-embed-card--media': isMediaCard,
    }"
  >
    <!-- Large thumbnail renders only in the default variant. MonyPost picks
         the compact variant when an inline rich embed (e.g. YouTube iframe)
         already represents the URL. The thumbnail variant renders the image
         at a small fixed size beside the text. -->
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
     * 'compact'   → slim caption row (no thumbnail). Metadata strip beneath
     *               an inline rich embed (e.g. YouTube iframe); avoids
     *               double-rendering the same URL's preview.
     * 'thumbnail' → fixed-size horizontal card (small thumbnail on left,
     *               one-line title + one-line description). Used when the
     *               post also has a media attachment, which is already the
     *               dominant visual; the card adds title/site context
     *               without duplicating the image size. Mirrors
     *               Mastodon/Misskey's "small card beneath the photo"
     *               layout.
     */
    variant?: 'default' | 'compact' | 'thumbnail';
  }>(),
  { variant: 'default' }
);

const emit = defineEmits<{
  'load': [];
}>();

// Starts loaded when no image will paint (no payload image, or the compact
// variant), so the parent's load listener fires without waiting.
const imageLoaded = ref(!props.payload.image || props.variant === 'compact');

// Media-first layout (Discord-style): a preview carrying an image and no
// description (e.g. a GIF page) is the content, so it renders at natural
// size instead of a 100px cropped square thumbnail.
const isMediaCard = computed(() =>
  props.variant === 'default' && !!props.payload.image && !props.payload.description
);

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
  if (!props.payload.image || props.variant === 'compact') {
    emit('load');
  }
});
</script>

