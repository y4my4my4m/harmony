import { ref, watch, type Ref } from 'vue'
import {
  findCustomEmojiByToken,
  findCustomEmojiInCache,
  normalizeToInnerToken,
} from '@/services/emojiShortcodeResolver'
import { userDataService } from '@/services/userDataService'
import type { DisplayNamePart } from '@/types'

/**
 * Resolves supporter tier badge_icon values for display.
 * Uses the global emoji shortcode resolver (cache + DB + ~N disambiguation).
 */
export function useSupporterBadgeIcon(iconSource: Ref<string | null | undefined>) {
  const parts = ref<DisplayNamePart[] | null>(null)
  const displayText = ref('⭐')

  let resolveGeneration = 0

  async function resolve(icon: string | null | undefined) {
    const gen = ++resolveGeneration

    if (!icon) {
      parts.value = null
      displayText.value = '⭐'
      return
    }

    displayText.value = icon

    const syncParts = userDataService.resolveDisplayNameParts(icon)
    if (syncParts?.some(p => p.type === 'emoji')) {
      parts.value = syncParts
      return
    }

    const inner = normalizeToInnerToken(icon)
    const cached = findCustomEmojiInCache(inner)
    if (cached?.url) {
      parts.value = [{
        type: 'emoji',
        emoji: { id: cached.id, name: cached.name, url: cached.url },
      }]
      return
    }

    const emoji = await findCustomEmojiByToken(icon)
    if (gen !== resolveGeneration) return

    if (emoji?.url) {
      parts.value = [{
        type: 'emoji',
        emoji: { id: emoji.id, name: emoji.name, url: emoji.url },
      }]
    } else {
      parts.value = null
    }
  }

  watch(iconSource, (icon) => { void resolve(icon) }, { immediate: true })

  return { parts, displayText }
}
