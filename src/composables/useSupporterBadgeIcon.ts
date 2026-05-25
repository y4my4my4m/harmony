import { ref, watch, type Ref } from 'vue'
import {
  findCustomEmojiByToken,
  findCustomEmojiInCache,
  normalizeToInnerToken,
} from '@/services/emojiShortcodeResolver'
import { userDataService } from '@/services/userDataService'
import { debug } from '@/utils/debug'
import type { DisplayNamePart } from '@/types'

const SHORTCODE_PATTERN = /^:[a-zA-Z0-9_+~-]+:$/
// One-time warn per shortcode so we don't spam when N message rows render
// the same broken badge_icon.
const warnedMissing = new Set<string>()

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
      return
    }

    parts.value = null

    // Surface tier misconfiguration: the admin saved a :shortcode: that
    // doesn't match any row in the emojis table for this instance.
    if (SHORTCODE_PATTERN.test(icon) && !warnedMissing.has(icon)) {
      warnedMissing.add(icon)
      debug.warn(
        `[SupporterBadge] No custom emoji found for tier icon ${icon}. ` +
        `Check Admin → Supporter Tiers; the shortcode must match an existing emoji name.`,
      )
    }
  }

  watch(iconSource, (icon) => { void resolve(icon) }, { immediate: true })

  return { parts, displayText }
}
