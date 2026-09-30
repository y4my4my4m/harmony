<template>
  <span
    class="egp"
    :class="{ 'egp-lost': lost, 'egp-decrypting': decrypting }"
    aria-hidden="true"
  ><span
      v-for="(char, idx) in glyphChars"
      :key="idx"
      class="egp-char"
    >{{ char }}</span></span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { generateGlyphPreview } from '@/utils/glyphPreview'

const props = withDefaults(defineProps<{
  content: string
  messageId?: string
  lost?: boolean
  decrypting?: boolean
}>(), {
  messageId: '',
  lost: false,
  decrypting: false,
})

const glyphChars = computed(() =>
  Array.from(generateGlyphPreview(props.content, props.messageId)),
)
</script>

<style scoped>
/* NOTE: no overflow/clip on this box - overflow other than visible moves an
   inline-block's baseline to its bottom edge and the glyphs ride high. */
.egp {
  display: inline-block;
  position: relative;
  font-family: 'IBM Plex Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  letter-spacing: 0.12em;
  user-select: none;
}

.egp-char {
  display: inline-block;
  color: var(--harmony-secondary);
  opacity: 0.8;
}

/* Static accent tiers. */
.egp-char:nth-child(5n) {
  color: var(--harmony-primary);
  opacity: 0.92;
}
.egp-char:nth-child(7n) {
  color: color-mix(in srgb, var(--harmony-primary) 60%, var(--harmony-secondary));
}
.egp-char:nth-child(11n) {
  opacity: 0.55;
}

/* Hover on the click-to-decrypt wrapper: chars snap into focus. */
:global(.encrypted-click-target:hover) .egp-char {
  opacity: 1;
  transition: opacity 0.15s ease;
}

/* Decrypting: dim while the spinner shows. */
.egp-decrypting .egp-char {
  opacity: 0.35;
}

/* Permanently unrecoverable (key gone): greyed. */
.egp-lost .egp-char {
  color: var(--text-muted);
  opacity: 0.5;
}
</style>
