<template>
  <span class="display-name" :class="{ truncate }" :style="nameStyle">
    <template v-if="finalParts && finalParts.length > 0">
      <template v-for="(part, i) in finalParts" :key="i">
        <span v-if="part.type === 'text'">{{ part.text }}</span>
        <img
          v-else-if="part.type === 'emoji'"
          class="display-name-emoji"
          :src="getEmojiUrl(part.emoji.url, 48)"
          :alt="`:${part.emoji.name}:`"
          :title="`:${part.emoji.name}:`"
          draggable="false"
        />
        <img
          v-else-if="part.type === 'unicode-emoji' && part.svgUrl"
          class="display-name-emoji"
          :src="part.svgUrl"
          :alt="part.unicode"
          :title="part.unicode"
          draggable="false"
        />
        <span v-else-if="part.type === 'unicode-emoji'">{{ part.unicode }}</span>
      </template>
    </template>
    <template v-else>{{ plainName }}</template>
  </span>
</template>

<script lang="ts">
const pendingUserFetches = new Set<string>()
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
</script>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useUserData } from '@/composables/useUserData'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'
import { userDataService } from '@/services/userDataService'
import { getEmojiUrl } from '@/utils/emojiUtils'
import type { DisplayNamePart } from '@/types'

type RenderPart =
  | DisplayNamePart
  | { type: 'unicode-emoji'; unicode: string; svgUrl: string | null }

const UNICODE_EMOJI_REGEX = /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu
const SHORTCODE_REGEX = /:([a-zA-Z0-9_+~-]+):/

const props = defineProps<{
  userId?: string
  parts?: DisplayNamePart[]
  fallback?: string
  color?: string
  truncate?: boolean
}>()

const { getUserDisplayName, getUserDisplayNameParts, getUser, fetchUserProfile } = useUserData()
const { resolveEmoji, isNativePack, isLoaded: emojiPackLoaded } = useUnifiedEmoji()

// Lazy-fetch unknown users so display names resolve with proper emoji parts.
// pendingUserFetches is module-level to deduplicate across all DisplayName instances.
watch(
  () => props.userId,
  (uid) => {
    if (!uid || !UUID_REGEX.test(uid) || pendingUserFetches.has(uid)) return
    if (getUser(uid).value) return
    pendingUserFetches.add(uid)
    fetchUserProfile(uid).finally(() => pendingUserFetches.delete(uid))
  },
  { immediate: true }
)

const resolvedParts = computed<DisplayNamePart[] | undefined>(() => {
  if (props.parts) return props.parts
  if (props.userId) return getUserDisplayNameParts(props.userId).value
  return undefined
})

/**
 * Post-process resolved parts: split unicode emojis out of text parts
 * and resolve them through the current emoji pack (twemoji/native).
 */
const finalParts = computed<RenderPart[] | undefined>(() => {
  let parts = resolvedParts.value

  // When the cache doesn't have resolved parts, try resolving shortcodes
  // directly from the plain name. This handles the case where the user
  // isn't in the cache yet or their displayNameParts weren't resolved
  // (e.g. emoji service loaded after profile was cached).
  if (!parts || parts.length === 0) {
    const text = plainName.value
    if (!text) return undefined

    if (SHORTCODE_REGEX.test(text) && emojiPackLoaded.value) {
      const resolved = userDataService.resolveDisplayNameParts(text)
      if (resolved && resolved.length > 0) {
        parts = resolved
      }
    }
  }

  if (!parts || parts.length === 0) {
    const text = plainName.value
    if (!text) return undefined
    const processed = processTextForUnicodeEmojis(text)
    if (processed.length === 1 && processed[0].type === 'text') return undefined
    return processed
  }

  const result: RenderPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push(...processTextForUnicodeEmojis(part.text))
    } else {
      result.push(part)
    }
  }
  return result
})

function processTextForUnicodeEmojis(text: string): RenderPart[] {
  if (!text) return []

  // If native pack or emoji data not loaded, just return text as-is
  // (browser will render unicode emojis natively)
  if (isNativePack.value || !emojiPackLoaded.value) {
    return [{ type: 'text' as const, text }]
  }

  const parts: RenderPart[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  UNICODE_EMOJI_REGEX.lastIndex = 0
  while ((match = UNICODE_EMOJI_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: text.substring(lastIndex, match.index) })
    }
    const resolved = resolveEmoji(match[0])
    parts.push({
      type: 'unicode-emoji',
      unicode: match[0],
      svgUrl: resolved.display.type === 'svg' ? resolved.display.content : null
    })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.substring(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ type: 'text', text }]
}

const plainName = computed(() => {
  if (props.userId) {
    const user = getUser(props.userId).value
    return user ? getUserDisplayName(props.userId).value : (props.fallback ?? 'Unknown User')
  }
  return props.fallback || 'Unknown User'
})

const nameStyle = computed(() => {
  if (props.color) return { color: props.color }
  return undefined
})
</script>

<style scoped>
.display-name {
  display: inline;
  vertical-align: baseline;
}

.display-name.truncate {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.display-name-emoji {
  height: 1.2em;
  width: auto;
  vertical-align: -0.2em;
  object-fit: contain;
}
</style>
