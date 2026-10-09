<template>
  <BaseModal
    :show="true"
    :show-header="false"
    overlay-class="reactions-modal"
    @close="emit('close')"
  >
    <div class="reactions-modal-layout" data-testid="reactions-modal">
      <header class="reactions-modal-header">
        <h2 class="reactions-modal-title">{{ $t('message.reactions.title') }}</h2>
        <button
          type="button"
          class="reactions-modal-close"
          :aria-label="$t('common.close')"
          @click="emit('close')"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <p v-if="groups.length === 0" class="reactions-modal-empty" data-testid="reactions-modal-empty">
        {{ $t('message.reactions.empty') }}
      </p>

      <div v-else class="reactions-modal-body">
        <div
          ref="tablistRef"
          class="reactions-modal-tabs"
          role="tablist"
          :aria-label="$t('message.reactions.title')"
          @keydown="handleTabKeydown"
        >
          <button
            v-for="group in groups"
            :key="reactionGroupKey(group)"
            type="button"
            role="tab"
            class="reactions-modal-tab"
            :class="{ active: reactionGroupKey(group) === activeKey }"
            :aria-selected="reactionGroupKey(group) === activeKey"
            :tabindex="reactionGroupKey(group) === activeKey ? 0 : -1"
            :title="emojiLabel(group)"
            :data-emoji-key="reactionGroupKey(group)"
            data-testid="reactions-modal-tab"
            @click="selectedKey = reactionGroupKey(group)"
          >
            <img
              v-if="isCustomEmoji(group) && !brokenEmojiUrls.has(group.emoji.url)"
              :src="getEmojiUrl(group.emoji.url, 48)"
              :alt="group.emoji.name || 'emoji'"
              class="reactions-modal-emoji"
              @error="brokenEmojiUrls.add(group.emoji.url)"
            />
            <template v-else-if="!isCustomEmoji(group) && resolvedEmoji(group)">
              <img
                v-if="resolvedEmoji(group)!.display.type === 'svg'"
                :src="resolvedEmoji(group)!.display.content"
                :alt="resolvedEmoji(group)!.shortcode || 'emoji'"
                class="reactions-modal-emoji"
              />
              <span v-else class="reactions-modal-emoji-glyph">{{ resolvedEmoji(group)!.display.content }}</span>
            </template>
            <span v-else class="reactions-modal-emoji-missing">?</span>
            <span class="reactions-modal-tab-count" data-testid="reactions-modal-tab-count">{{ group.count }}</span>
          </button>
        </div>

        <ul class="reactions-modal-users" role="tabpanel" :aria-label="activeGroup ? emojiLabel(activeGroup) : undefined">
          <li v-for="user in users" :key="user.key">
            <button
              type="button"
              class="reactions-modal-user"
              data-testid="reactions-modal-user"
              @click="emit('select-user', user)"
            >
              <Avatar :src="user.avatarUrl" size="sm" class="reactions-modal-avatar" />
              <span class="reactions-modal-user-text">
                <span class="reactions-modal-user-name-row">
                  <span class="reactions-modal-user-name" :style="{ color: user.userColor }">
                    <DisplayName
                      v-if="user.kind === 'user' && user.id"
                      :user-id="user.id"
                      :fallback="user.displayName"
                      :color="user.userColor"
                    />
                    <template v-else>{{ user.displayName }}</template>
                  </span>
                  <BridgeSourceBadge v-if="user.bridgeSource" :source="user.bridgeSource" />
                  <span v-else-if="user.kind === 'bot'" class="reactions-modal-bot-tag">{{ $t('bots.badge.bot') }}</span>
                </span>
                <span v-if="user.handle" class="reactions-modal-user-handle">{{ user.handle }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import BridgeSourceBadge from '@/components/messages/BridgeSourceBadge.vue'
import { useReactionsStore } from '@/stores/useReactions'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'
import { getEmojiUrl } from '@/utils/emojiUtils'
import {
  reactionGroupKey,
  toReactionUsers,
  type ReactionUser,
  type ReactionUserResolvers,
} from '@/utils/reactionUsers'
import type { ReactionGroup } from '@/types'

const props = defineProps<{
  messageId: string
  /** reactionGroupKey of the tab selected on open; null selects the first. */
  initialEmojiKey?: string | null
  resolvers: ReactionUserResolvers
}>()

const emit = defineEmits<{
  close: []
  'select-user': [user: ReactionUser]
}>()

const reactionsStore = useReactionsStore()
const { resolveEmoji } = useUnifiedEmoji()

const groups = computed<ReactionGroup[]>(() => reactionsStore.getMessageReactions(props.messageId))

const selectedKey = ref<string | null>(props.initialEmojiKey ?? null)

watch(
  () => [props.messageId, props.initialEmojiKey] as const,
  ([, key]) => { selectedKey.value = key ?? null },
)

// A tab removed by a live update falls back to the first; it is selected again if it returns.
const activeKey = computed<string | null>(() => {
  const keys = groups.value.map(reactionGroupKey)
  if (selectedKey.value && keys.includes(selectedKey.value)) return selectedKey.value
  return keys[0] ?? null
})

const activeGroup = computed(() =>
  groups.value.find(group => reactionGroupKey(group) === activeKey.value) ?? null,
)

const users = computed(() => toReactionUsers(activeGroup.value?.reactions, props.resolvers))

watch(
  () => groups.value.flatMap(group => (group.reactions ?? []).map(r => r.user_id || r.bot_id || '')).join(','),
  () => props.resolvers.preload?.(groups.value.flatMap(group => group.reactions ?? [])),
  { immediate: true },
)

const brokenEmojiUrls = ref(new Set<string>())

const isCustomEmoji = (group: ReactionGroup): boolean =>
  !!group.emoji?.url && !(group.emoji as { is_native?: boolean }).is_native

const resolvedEmoji = (group: ReactionGroup) => {
  const emoji = group.emoji as (ReactionGroup['emoji'] & { content?: string }) | undefined
  const identifier = emoji?.content || emoji?.name || emoji?.id || group.emoji_id
  if (!identifier) return null
  try {
    return resolveEmoji(identifier)
  } catch {
    return null
  }
}

/** `:shortcode:` of the emoji, the same label ReactionTooltip shows. */
const emojiLabel = (group: ReactionGroup): string => {
  if (isCustomEmoji(group)) return `:${group.emoji.name}:`
  const shortcode = resolvedEmoji(group)?.shortcode
  return shortcode ? `:${shortcode}:` : (group.emoji?.name || '')
}

const tablistRef = ref<HTMLElement | null>(null)

// WAI-ARIA tabs pattern: arrows move selection and focus, Home/End jump to the ends.
const handleTabKeydown = (event: KeyboardEvent) => {
  const keys = groups.value.map(reactionGroupKey)
  if (keys.length === 0) return
  const current = Math.max(0, keys.indexOf(activeKey.value ?? ''))
  let next: number
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowRight':
      next = (current + 1) % keys.length
      break
    case 'ArrowUp':
    case 'ArrowLeft':
      next = (current - 1 + keys.length) % keys.length
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = keys.length - 1
      break
    default:
      return
  }
  event.preventDefault()
  selectedKey.value = keys[next]
  void nextTick(() => {
    tablistRef.value?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  })
}
</script>

<style scoped>
.reactions-modal-layout {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.reactions-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--border-secondary);
  flex-shrink: 0;
}

.reactions-modal-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.reactions-modal-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
}

.reactions-modal-close:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.reactions-modal-empty {
  margin: 0;
  padding: 32px 16px;
  text-align: center;
  color: var(--text-muted);
}

.reactions-modal-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.reactions-modal-tabs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 104px;
  padding: 8px;
  overflow-y: auto;
  border-right: 1px solid var(--border-secondary);
  background: var(--background-secondary-alpha, transparent);
  flex-shrink: 0;
}

.reactions-modal-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
}

.reactions-modal-tab:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.reactions-modal-tab.active {
  background: var(--harmony-primary-alpha);
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

.reactions-modal-tab:focus-visible,
.reactions-modal-user:focus-visible,
.reactions-modal-close:focus-visible {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: -2px;
}

.reactions-modal-emoji {
  max-width: 48px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
}

.reactions-modal-emoji-glyph {
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
}

.reactions-modal-emoji-missing {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}

.reactions-modal-tab-count {
  font-size: var(--font-size-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.reactions-modal-users {
  list-style: none;
  margin: 0;
  padding: 8px;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.reactions-modal-user {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: background-color 0.15s ease;
}

.reactions-modal-user:hover {
  background: var(--background-modifier-hover);
}

.reactions-modal-avatar {
  flex-shrink: 0;
}

.reactions-modal-user-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.reactions-modal-user-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.reactions-modal-user-name {
  font-size: var(--font-size-base);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.reactions-modal-user-handle {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reactions-modal-bot-tag {
  flex-shrink: 0;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.3;
  text-transform: uppercase;
}

/* Narrow or touch: the emoji rail becomes a horizontal strip above the list. */
@media (max-width: 768px), (pointer: coarse) {
  .reactions-modal-body {
    flex-direction: column;
  }

  .reactions-modal-tabs {
    flex-direction: row;
    width: auto;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid var(--border-secondary);
    scrollbar-width: none;
  }

  .reactions-modal-tabs::-webkit-scrollbar {
    display: none;
  }

  .reactions-modal-tab {
    min-height: 40px;
    padding: 6px 10px;
  }

  .reactions-modal-user {
    min-height: 52px;
  }
}
</style>

<!-- Unscoped: BaseModal teleports to body. The overlay class outranks BaseModal's
     scoped .modal-container/.modal-content rules (0,2,0) regardless of stylesheet order. -->
<style>
.modal-overlay.reactions-modal .modal-container {
  max-width: 460px;
  height: min(70vh, 520px);
}

.modal-overlay.reactions-modal .modal-content {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px), (pointer: coarse) {
  .modal-overlay.reactions-modal .modal-container {
    height: min(80vh, 560px);
  }
}
</style>
