import { defineStore } from 'pinia'
import { computed } from 'vue'
import { services } from '@/services'
import type { ReactionGroup, Emoji } from '@/types'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useProfileStore } from '@/stores/useProfile'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'
import { createReactionEngine } from '@/stores/shared/reactionEngine'

/** Emoji input for a message reaction toggle. */
interface MessageReactionInput {
  emojiId: string
  emojiData?: Emoji
}

const isUuid = (str: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)

function matchesEmoji(group: ReactionGroup, emojiId: string): boolean {
  return isUuid(emojiId)
    ? group.emoji_id === emojiId
    : !group.emoji_id && group.emoji?.name === emojiId
}

/**
 * Build the optimistic group array for a message reaction toggle. Keeps the
 * emoji-display resolution (cache -> unified emoji) so a brand-new chip renders
 * its image instantly, and maintains `current_user_reacted` + `count` so the
 * highlight and counter are correct before the server reconciles.
 */
function buildOptimisticGroups(
  base: ReactionGroup[],
  emojiId: string,
  actorId: string,
  operation: 'add' | 'remove',
  providedEmojiData?: Emoji,
): ReactionGroup[] {
  const result = JSON.parse(JSON.stringify(base)) as ReactionGroup[]
  const index = result.findIndex(g => matchesEmoji(g, emojiId))

  if (operation === 'add') {
    if (index >= 0) {
      const existing = result[index]
      if (!existing.current_user_reacted) {
        existing.reactions = existing.reactions || []
        existing.reactions.push({ reaction_id: 'temp-' + Date.now(), user_id: actorId })
        existing.count = (existing.count || 0) + 1
        existing.current_user_reacted = true
      }
      return result
    }

    let emoji: Emoji
    if (providedEmojiData) {
      emoji = providedEmojiData
    } else {
      const cached = useEmojiCacheStore().getEmojiById(emojiId)
      if (cached) {
        emoji = cached
      } else if (!isUuid(emojiId)) {
        // Unicode/shortcode: resolve display fields, but keep name/content equal
        // to the raw id so the optimistic group's key matches what the server
        // stores in custom_emoji_content (avoids a TransitionGroup re-key).
        const { resolveEmoji } = useUnifiedEmoji()
        const resolved = resolveEmoji(emojiId)
        emoji = {
          id: emojiId,
          name: emojiId,
          content: emojiId,
          url: resolved.display.type === 'svg' ? resolved.display.content : '',
          native: resolved.unicode,
          unicode: resolved.unicode,
          server_id: '',
          uploader: '',
          usage_count: 0,
        } as any
      } else {
        emoji = { id: emojiId, name: 'unknown', url: '', server_id: '', uploader: '', usage_count: 0 } as any
      }
    }

    result.push({
      emoji_id: isUuid(emojiId) ? emojiId : null,
      emoji,
      count: 1,
      current_user_reacted: true,
      reactions: [{ reaction_id: 'temp-' + Date.now(), user_id: actorId }],
    })
  } else {
    if (index >= 0) {
      const existing = result[index]
      existing.reactions = existing.reactions?.filter(r => r.user_id !== actorId) || []
      existing.count = Math.max(0, (existing.count || 1) - 1)
      existing.current_user_reacted = false
      if (existing.count === 0) result.splice(index, 1)
    }
  }

  return result
}

export const useReactionsStore = defineStore('reactions', () => {
  const engine = createReactionEngine<ReactionGroup, MessageReactionInput>({
    async fetchBatch(messageIds) {
      // Single fetch uses the richer singular RPC (carries usernames for
      // tooltips); batch fetch uses the lean RPC to avoid N+1 on history load.
      if (messageIds.length === 1) {
        const groups = await services.messages.getMessageReactions(messageIds[0])
        return { [messageIds[0]]: groups as unknown as ReactionGroup[] }
      }
      return await services.messages.getBatchMessageReactions(messageIds) as unknown as Record<string, ReactionGroup[]>
    },
    async toggleOnServer(messageId, emoji) {
      await services.messages.toggleReaction(messageId, emoji.emojiId)
    },
    applyOptimistic(base, emoji, operation) {
      const actorId = useProfileStore().profileId || ''
      return buildOptimisticGroups(base, emoji.emojiId, actorId, operation, emoji.emojiData)
    },
    matchesEmoji: (group, emoji) => matchesEmoji(group, emoji.emojiId),
    hasReacted: (group) => group.current_user_reacted ?? false,
    groupKey: (g) => (g.emoji_id || g.emoji?.name || (g.emoji as any)?.content || 'unknown'),
    emojiKey: (emoji) => emoji.emojiId,
    entityIdFromRealtime: (payload) => payload?.new?.message_id || payload?.old?.message_id,
    realtimeReconcileDelayMs: 400,
  })

  // Server-boolean model: trailing userId param accepted for back-compat, ignored.
  const hasUserReacted = computed(() =>
    (messageId: string, emojiId: string, _userId?: string): boolean =>
      engine.hasUserReacted.value(messageId, { emojiId }))

  // Public API (message-named wrappers around the shared engine).
  return {
    reactionsByMessage: engine.reactionsByEntity,
    getMessageReactions: engine.getReactions,
    isLoadingReactions: engine.isLoadingReactions,
    hasUserReacted,

    fetchMessageReactions: (messageId: string, force = false) => engine.fetch(messageId, force),
    fetchMultipleMessageReactions: (messageIds: string[], force = false) => engine.fetchMultiple(messageIds, force),

    toggleReaction: (messageId: string, emojiId: string, _userId?: string, emojiData?: Emoji) =>
      engine.toggle(messageId, { emojiId, emojiData }),

    handleRealtimeUpdate: engine.handleRealtimeUpdate,
    clearOptimisticState: engine.clearOptimisticState,
    bulkSetReactions: engine.bulkSet,
    $dispose: engine.dispose,
  }
})
