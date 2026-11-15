import { computed, onMounted, type ComputedRef } from 'vue'
import { PERSONAL_EMOJI_GROUPS, useEmojiCacheStore } from '@/stores/useEmojiCache'
import { authContextService } from '@/services/AuthContextService'
import type { EmojiUrls } from '@/utils/announcementContent'

/**
 * This instance's own custom emoji by name, from the emoji picker's instance group
 * (useEmojiCache.loadPersonalEmojis), loaded on mount when absent. The first emoji of a name wins.
 */
export function useInstanceEmojiUrls(): ComputedRef<EmojiUrls> {
  const store = useEmojiCacheStore()

  onMounted(() => {
    authContextService.getCurrentContext()
      .then((ctx) => store.loadPersonalEmojis(ctx.profileId ?? null))
      .catch(() => store.loadPersonalEmojis(null))
  })

  return computed(() => {
    const urls = new Map<string, string>()
    const group = store.serverCaches.get(PERSONAL_EMOJI_GROUPS.instance)
    for (const { emoji } of group?.emojis.values() ?? []) {
      if (emoji.url && !urls.has(emoji.name)) urls.set(emoji.name, emoji.url)
    }
    return urls
  })
}
