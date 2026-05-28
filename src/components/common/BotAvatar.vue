<template>
  <div class="bot-avatar-wrapper" :style="{ width: size + 'px', height: size + 'px' }">
    <!-- Real uploaded avatar takes precedence -->
    <Avatar
      v-if="bot?.avatar_url"
      :src="bot.avatar_url"
      :alt="bot.username || 'Bot'"
      :size="avatarSize"
      class="bot-avatar-image"
    />
    <!-- Platform-branded icon for known bridge bots (discord-bridge, etc.) -->
    <div
      v-else-if="platformKey"
      class="bot-avatar-platform"
      :class="`bot-avatar-platform--${platformKey}`"
      :style="{ width: size + 'px', height: size + 'px' }"
    >
      <PlatformIcon :platform="platformKey" :size="Math.round(size * 0.55)" />
    </div>
    <!-- Generic fallback: monogram derived from username -->
    <div v-else class="bot-avatar-generic" :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' }">
      {{ initials }}
    </div>
    <!-- Online dot (optional) -->
    <span
      v-if="showStatus"
      class="bot-avatar-status"
      :class="{ online: !!bot?.last_online_at }"
    ></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Avatar from './Avatar.vue'
import PlatformIcon from './PlatformIcon.vue'

/**
 * Bot avatar with three rendering tiers:
 *  1. Uploaded avatar_url → real image
 *  2. Known bridge bot (matched by username) → branded platform icon
 *  3. Anything else → 2-letter initials block
 *
 * To register a new bridge: add a (username pattern) → (platform key) entry
 * to BRIDGE_PLATFORM_MAP. The platform key must exist in PlatformIcon's
 * registered icons.
 */
const BRIDGE_PLATFORM_MAP: Array<{ pattern: RegExp; platform: string; color: string }> = [
  { pattern: /^discord[-_]?bridge$/i, platform: 'discord', color: '#5865f2' },
  { pattern: /^slack[-_]?bridge$/i, platform: 'slack', color: '#4a154b' },
  { pattern: /^telegram[-_]?bridge$/i, platform: 'telegram', color: '#26a5e4' },
  { pattern: /^matrix[-_]?bridge$/i, platform: 'matrix', color: '#0dbd8b' },
  { pattern: /^irc[-_]?bridge$/i, platform: 'irc', color: '#000' },
  { pattern: /^twitch[-_]?bridge$/i, platform: 'twitch', color: '#9146ff' },
]

const props = withDefaults(defineProps<{
  bot?: { username?: string; avatar_url?: string | null; last_online_at?: string | null; bot_type?: string | null } | null
  size?: number
  showStatus?: boolean
}>(), {
  bot: null,
  size: 40,
  showStatus: false,
})

const avatarSize = computed(() => {
  // Avatar.vue accepts t-shirt sizes; pick the closest.
  if (props.size <= 24) return 'xs'
  if (props.size <= 32) return 'sm'
  if (props.size <= 48) return 'md'
  return 'lg'
})

const matchedBridge = computed(() => {
  const username = props.bot?.username ?? ''
  if (!username) return null
  return BRIDGE_PLATFORM_MAP.find(b => b.pattern.test(username)) ?? null
})

const platformKey = computed(() => matchedBridge.value?.platform ?? null)

const initials = computed(() => {
  const u = (props.bot?.username ?? 'B').replace(/[-_]/g, ' ').trim()
  const parts = u.split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || 'B'
})
</script>

<style scoped>
.bot-avatar-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.bot-avatar-image {
  width: 100%;
  height: 100%;
}

.bot-avatar-platform {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  /* Default: hex var resolved per-bridge below */
  background: var(--bot-bridge-color, var(--harmony-primary, #0EA5E9));
}

.bot-avatar-platform--discord { background: #5865f2; }
.bot-avatar-platform--slack { background: #4a154b; }
.bot-avatar-platform--telegram { background: #26a5e4; }
.bot-avatar-platform--matrix { background: #0dbd8b; }
.bot-avatar-platform--irc { background: #1f1f1f; }
.bot-avatar-platform--twitch { background: #9146ff; }

.bot-avatar-generic {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-weight: 600;
  border: 1px solid var(--border-color);
}

.bot-avatar-status {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-tertiary, #72767d);
  border: 2px solid var(--background-primary, #1e1f22);
}

.bot-avatar-status.online {
  background: #3ba55c;
}
</style>
