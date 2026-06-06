<script setup lang="ts">
import { computed } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import { getEmojiUrl } from '@/utils/emojiCdnHelper'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'

interface Props {
  visible: boolean
  x: number
  y: number
  emoji: { name?: string; url?: string; content?: string; is_native?: boolean } | null
  users: Array<{
    id: string
    displayName: string
    avatarUrl: string
    userColor: string
    isBridged?: boolean
    bridgeSource?: string
  }>
}

const props = defineProps<Props>()

const { resolveEmoji } = useUnifiedEmoji()

/**
 * Custom (uploaded/AI) emoji render as their hosted image with a `:shortcode:`
 * label. Native unicode reactions are identified inconsistently across the
 * optimistic vs reconciled paths (optimistic carries the shortcode in `name`,
 * the server returns the unicode glyph), so we resolve them through the unified
 * service to always show the glyph + canonical `:shortcode:` regardless.
 */
const isCustom = computed(() => !!props.emoji?.url && !props.emoji?.is_native)

const resolved = computed(() => {
  if (!props.emoji || isCustom.value) return null
  const identifier = props.emoji.content || props.emoji.name
  if (!identifier) return null
  try {
    return resolveEmoji(identifier)
  } catch {
    return null
  }
})

/** Clean `:shortcode:` label, falling back to the raw name only if unresolved. */
const label = computed(() => {
  if (isCustom.value) return `:${props.emoji?.name}:`
  const shortcode = resolved.value?.shortcode
  return shortcode ? `:${shortcode}:` : ''
})
</script>

<template>
  <div
    v-if="visible"
    class="reaction-tooltip"
    :style="{ top: y + 10 + 'px', left: x + 'px' }"
  >
    <div class="tooltip-header">
      <img
        v-if="isCustom"
        :src="getEmojiUrl(emoji!.url!, 48)"
        :alt="emoji?.name || 'emoji'"
        class="tooltip-emoji"
      />
      <img
        v-else-if="resolved?.display.type === 'svg'"
        :src="resolved.display.content"
        :alt="resolved.shortcode || 'emoji'"
        class="tooltip-emoji"
      />
      <span v-else-if="resolved" class="tooltip-emoji-glyph">{{ resolved.display.content }}</span>
      <span v-if="label" class="emoji-name">{{ label }}</span>
    </div>
    <div v-for="user in users" :key="user.id" class="tooltip-user">
      <Avatar
        :src="user.avatarUrl"
        size="xs"
        :fetch-size="48"
        class="tooltip-avatar"
      />
      <span :style="{ color: user.userColor }">
        <DisplayName :userId="user.id" :fallback="user.displayName" :color="user.userColor" />
      </span>
      <span v-if="user.isBridged" class="bridged-badge" :title="'From ' + user.bridgeSource">
        <svg v-if="user.bridgeSource === 'discord'" width="12" height="12" viewBox="0 0 24 24" fill="#5865F2">
          <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z"/>
        </svg>
      </span>
    </div>
  </div>
</template>

<style scoped>
.reaction-tooltip {
  position: fixed;
  background-color: var(--tooltip-bg, #18191c);
  color: var(--tooltip-text, var(--text-primary));
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 0.875rem;
  font-weight: 500;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
  pointer-events: none;
  max-width: 300px;
  transform: translateX(-50%);
}

.tooltip-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  margin-right: 8px;
}

.tooltip-user {
  display: flex;
  align-items: center;
  gap: 4px;
}

.bridged-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
}

.tooltip-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 8px 0;
  margin-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--h-black-lighter) 30%, transparent);
}

.tooltip-emoji {
  width: 48px;
  height: 48px;
  margin-right: 4px;
}

.tooltip-emoji-glyph {
  font-size: 36px;
  line-height: 1;
  margin-right: 4px;
}

.emoji-name {
  font-size: 0.875rem;
  color: var(--tooltip-text, var(--text-secondary));
  opacity: 0.9;
}
</style>
