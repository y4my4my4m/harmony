<template>
  <article class="link-embed-card" :class="{ 'link-embed-card--has-image': !!payload.image }">
    <div v-if="payload.image" class="link-embed-card__media">
      <img
        :src="payload.image"
        :alt="payload.title || payload.siteName || 'Link preview image'"
        loading="lazy"
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
import { computed } from 'vue';
import type { EmbedPayload } from '@/types';

const props = defineProps<{
  payload: EmbedPayload;
}>();

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
</script>

