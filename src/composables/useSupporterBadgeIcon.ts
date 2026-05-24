import { ref, watch, type Ref } from 'vue'
import { supabase } from '@/supabase'
import { userDataService } from '@/services/userDataService'
import type { DisplayNamePart } from '@/types'

const SHORTCODE_REGEX = /^:([a-zA-Z0-9_+-]+):$/

/**
 * Resolves supporter tier badge_icon values (unicode, :shortcode:, or emoji id)
 * into display parts. Custom server emojis are fetched from DB when not in cache.
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

    const match = icon.match(SHORTCODE_REGEX)
    if (!match) {
      parts.value = null
      return
    }

    try {
      const { data, error } = await supabase
        .from('emojis')
        .select('id, name, url')
        .eq('name', match[1])
        .limit(1)

      if (gen !== resolveGeneration) return
      if (error) throw error

      const emoji = data?.[0]
      if (emoji?.url) {
        parts.value = [{
          type: 'emoji',
          emoji: { id: emoji.id, name: emoji.name, url: emoji.url },
        }]
      } else {
        parts.value = null
      }
    } catch {
      if (gen === resolveGeneration) {
        parts.value = null
      }
    }
  }

  watch(iconSource, (icon) => { void resolve(icon) }, { immediate: true })

  return { parts, displayText }
}
