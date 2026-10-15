<template>
  <img
    v-if="src"
    class="sbe-img"
    :src="src"
    :alt="`:${customEmoji?.name ?? ''}:`"
    :width="size"
    :height="size"
    loading="lazy"
    decoding="async"
    draggable="false"
    data-testid="soundboard-custom-emoji"
  />
  <span v-else class="sbe-text">{{ emoji || '🔊' }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { getEmojiUrl } from '@/utils/emojiUtils';
import type { SoundboardCustomEmoji } from '@/services/soundboard/sounds';

const props = withDefaults(defineProps<{
  emoji?: string | null;
  customEmoji?: Pick<SoundboardCustomEmoji, 'name' | 'url'> | null;
  /** Rendered edge, CSS px. */
  size?: number;
}>(), {
  emoji: null,
  customEmoji: null,
  size: 18,
});

// Requested at twice the rendered edge for high-density screens.
const src = computed(() => (props.customEmoji?.url ? getEmojiUrl(props.customEmoji.url, props.size * 2) : ''));
</script>

<style scoped>
.sbe-img {
  display: inline-block;
  object-fit: contain;
  vertical-align: middle;
}
</style>
