<template>
  <span
    class="egp"
    :class="{ 'egp-lost': lost, 'egp-decrypting': decrypting }"
    :style="{ '--egp-delay': delay }"
    aria-hidden="true"
  ><span
      v-for="(char, idx) in glyphChars"
      :key="idx"
      class="egp-char"
      :style="{ '--i': idx }"
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

// Desync each message so a column of glyphs doesn't pulse in lockstep.
const delay = computed(() => {
  const id = props.messageId || props.content
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return `-${(h % 4000)}ms`
})
</script>

<style scoped>
/*
  Per-char "alive" effect, GPU-cheap.

  Each glyph animates ONLY transform + opacity — the compositor handles these
  with no layout and no repaint (the glyph texture is painted once, then just
  moved/faded on the GPU). The staggered per-char delay (--i) gives the ripple.
  What we deliberately DON'T animate: text-shadow, filter, background-position,
  color — those force per-frame repaints. Glow is a STATIC text-shadow.
  Glyph count is capped (<=48) and the message list is virtualized, so only
  on-screen rows exist.
*/
/* NOTE: no overflow/clip on this box - overflow other than visible moves an
   inline-block's baseline to its bottom edge and the glyphs ride high. */
.egp {
  display: inline-block;
  position: relative;
  font-family: 'IBM Plex Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  letter-spacing: 0.12em;
  user-select: none;
  /* Whole-string glitch blip — one transform on the container, cheap. */
  animation: egpGlitch 7s steps(1, end) infinite;
  animation-delay: var(--egp-delay, 0s);
}

.egp-char {
  display: inline-block;
  color: var(--harmony-secondary);
  opacity: 0.8;
  text-shadow:
    0 0 5px color-mix(in srgb, var(--harmony-primary) 50%, transparent),
    0 0 10px color-mix(in srgb, var(--harmony-primary) 30%, transparent);
  /* Negative delay via --i so the ripple is mid-flight on first paint. */
  animation:
    egpFloat 3.2s ease-in-out infinite,
    egpFlicker 4.6s ease-in-out infinite;
  animation-delay:
    calc(var(--egp-delay, 0s) - var(--i) * 90ms),
    calc(var(--egp-delay, 0s) - var(--i) * 140ms);
}

/* Static accent tiers (no animation cost). */
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

@keyframes egpFloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

@keyframes egpFlicker {
  0%, 100% { opacity: 0.8; }
  45% { opacity: 0.6; }
  70% { opacity: 0.95; }
}

/* One-element skew blip: identity most of the cycle, brief jitter near the end. */
@keyframes egpGlitch {
  0%, 90%, 100% { transform: translate(0, 0) skewX(0deg); }
  92% { transform: translate(-2px, 0) skewX(-3deg); }
  94% { transform: translate(2px, 0) skewX(3deg); }
  96% { transform: translate(-1px, 0) skewX(-1.5deg); }
  98% { transform: translate(1px, 0) skewX(1deg); }
}

/* Hover on the click-to-decrypt wrapper: chars snap into focus. */
:global(.encrypted-click-target:hover) .egp-char {
  opacity: 1;
  animation-play-state: paused;
  transition: opacity 0.15s ease;
}

/* Decrypting: freeze + dim while the spinner shows. */
.egp-decrypting { animation: none; }
.egp-decrypting .egp-char {
  animation: none;
  opacity: 0.35;
}

/* Permanently unrecoverable (key gone): static, greyed, no motion. */
.egp-lost { animation: none; }
.egp-lost .egp-char {
  color: var(--text-muted, var(--text-secondary, #888));
  text-shadow: none;
  opacity: 0.5;
  filter: grayscale(1);
  animation: none;
}

@media (prefers-reduced-motion: reduce) {
  .egp,
  .egp-char {
    animation: none;
  }
}
</style>
