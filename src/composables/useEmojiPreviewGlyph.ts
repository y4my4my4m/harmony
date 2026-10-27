import { ref } from 'vue'

export interface EmojiPreviewGlyph {
  src?: string
  char?: string
}

/**
 * Glyph of the `.emoji-item` an event lands in: its image's `data-preview-src` (a larger
 * rendition than the grid's), else the image itself, else its `.native-emoji-char`.
 * Bound once on the grid container to pointerover and focusin.
 */
export function useEmojiPreviewGlyph() {
  const glyph = ref<EmojiPreviewGlyph | null>(null)

  const track = (event: Event) => {
    const item = (event.target as Element | null)?.closest?.('.emoji-item')
    if (!item) return
    const img = item.querySelector('img')
    if (img) {
      glyph.value = { src: img.dataset.previewSrc || img.currentSrc || img.src }
      return
    }
    const char = item.querySelector('.native-emoji-char')?.textContent?.trim()
    glyph.value = char ? { char } : null
  }

  return { glyph, track }
}
