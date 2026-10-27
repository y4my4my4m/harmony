<template>
  <!-- Fixed height: the grid above never moves as the preview changes. -->
  <div class="emoji-preview-bar" aria-hidden="true" data-testid="emoji-preview-bar">
    <template v-if="name">
      <img
        v-if="glyph?.src"
        :src="glyph.src"
        alt=""
        decoding="async"
        class="emoji-preview-glyph"
        data-testid="emoji-preview-glyph"
      />
      <span
        v-else-if="glyph?.char"
        class="emoji-preview-glyph emoji-preview-char"
        data-testid="emoji-preview-glyph"
      >{{ glyph.char }}</span>
      <span class="emoji-preview-name">:{{ name }}:</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { EmojiPreviewGlyph } from '@/composables/useEmojiPreviewGlyph'

defineProps<{
  name: string | null
  glyph: EmojiPreviewGlyph | null
}>()
</script>

<style scoped>
.emoji-preview-bar {
  height: 48px;
  padding: 0 12px;
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  min-width: 0;
}

.emoji-preview-glyph {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  object-fit: contain;
  -webkit-user-drag: none;
  user-select: none;
}

.emoji-preview-char {
  font-size: 28px;
  line-height: 32px;
  text-align: center;
}

.emoji-preview-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary, var(--text-secondary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Touch: a press previews only while held, so the bar stays compact. */
@media (hover: none) {
  .emoji-preview-bar {
    height: 36px;
  }

  .emoji-preview-glyph {
    width: 24px;
    height: 24px;
  }

  .emoji-preview-char {
    font-size: 20px;
    line-height: 24px;
  }
}
</style>
