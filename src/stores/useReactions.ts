import { defineStore } from 'pinia'
import { computed } from 'vue'
import { services } from '@/services'
import type { ReactionGroup, Emoji } from '@/types'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useProfileStore } from '@/stores/useProfile'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'
import { createReactionEngine } from '@/stores/shared/reactionEngine'

interface MessageReactionInput {
  emojiId: string
  emojiData?: Emoji
}

/** A reaction actor - the current user (own toggle) or a remote user from a broadcast. */
interface ReactionActor {
  id?: string | null
  bot_id?: string | null
  username?: string
  display_name?: string
  avatar_url?: string
}

const isUuid = (str: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)

const actorKey = (actor: ReactionActor): string => (actor.id || actor.bot_id || '') as string

function matchesEmoji(group: ReactionGroup, emojiId: string): boolean {
  return isUuid(emojiId)
    ? group.emoji_id === emojiId
    : !group.emoji_id && group.emoji?.name === emojiId
}

function makeReactionEntry(actor: ReactionActor): any {
  return {
    reaction_id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user_id: actor.id ?? undefined,
    bot_id: actor.bot_id ?? undefined,
    username: actor.username,
    display_name: actor.display_name,
    avatar_url: actor.avatar_url,
  }
}

function resolveEmojiForGroup(emojiId: string, providedEmojiData?: Emoji): Emoji {
  if (providedEmojiData) return providedEmojiData

  const cached = useEmojiCacheStore().getEmojiById(emojiId)
  if (cached) return cached

  if (!isUuid(emojiId)) {
    // Unicode/shortcode: resolve display fields, but keep name/content equal to
    // the raw id so the group's key matches what the server stores in
    // custom_emoji_content (avoids a TransitionGroup re-key).
    const { resolveEmoji } = useUnifiedEmoji()
    const resolved = resolveEmoji(emojiId)
    return {
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
  }

  return { id: emojiId, name: 'unknown', url: '', server_id: '', uploader: '', usage_count: 0 } as any
}

/**
 * Apply a single reaction add/remove to a group array, returning a new array.
 * Shared by the current user's optimistic toggle and remote broadcast deltas.
 * Dedup is keyed on the actor so a user's own broadcast echo can't double-count,
 * and `current_user_reacted` only flips when the actor is the current user.
 */
function buildOptimisticGroups(
  base: ReactionGroup[],
  emojiId: string,
  actor: ReactionActor,
  operation: 'add' | 'remove',
  isCurrentUser: boolean,
  providedEmojiData?: Emoji,
): ReactionGroup[] {
  const result = JSON.parse(JSON.stringify(base)) as ReactionGroup[]
  const index = result.findIndex(g => matchesEmoji(g, emojiId))
  const key = actorKey(actor)
  const hasActor = (g: ReactionGroup) =>
    (g.reactions || []).some(r => (r.user_id || (r as any).bot_id) === key)

  if (operation === 'add') {
    if (index >= 0) {
      const existing = result[index]
      existing.reactions = existing.reactions || []
      if (!hasActor(existing)) {
        existing.reactions.push(makeReactionEntry(actor))
        existing.count = (existing.count || 0) + 1
        if (isCurrentUser) existing.current_user_reacted = true
      }
      return result
    }

    result.push({
      emoji_id: isUuid(emojiId) ? emojiId : null,
      emoji: resolveEmojiForGroup(emojiId, providedEmojiData),
      count: 1,
      current_user_reacted: isCurrentUser,
      reactions: [makeReactionEntry(actor)],
    })
  } else {
    if (index >= 0) {
      const existing = result[index]
      existing.reactions = existing.reactions?.filter(
        r => (r.user_id || (r as any).bot_id) !== key,
      ) || []
      existing.count = Math.max(0, (existing.count || 1) - 1)
      if (isCurrentUser) existing.current_user_reacted = false
      if (existing.count === 0) result.splice(index, 1)
    }
  }

  return result
}

export const useReactionsStore = defineStore('reactions', () => {
  const engine = createReactionEngine<ReactionGroup, MessageReactionInput>({
    async fetchBatch(messageIds) {
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
      return buildOptimisticGroups(base, emoji.emojiId, { id: actorId }, operation, true, emoji.emojiData)
    },
    applyRealtimeDelta(base, payload) {
      const emojiId: string | undefined = payload?.emoji_id || payload?.custom_emoji_content
      if (!emojiId || !(payload?.user_id || payload?.bot_id)) return null
      const operation = (payload?.op === 'DELETE' || payload?.type === 'reaction:delete') ? 'remove' : 'add'
      const isCurrentUser = !!payload.user_id && payload.user_id === (useProfileStore().profileId || '')
      // Custom (server) emoji carry name/url in the payload so a brand-new chip
      // renders even when this client hasn't cached the emoji.
      const emojiData = payload.emoji_id
        ? ({ id: payload.emoji_id, name: payload.emoji_name, url: payload.emoji_url } as Emoji)
        : undefined
      return buildOptimisticGroups(
        base,
        emojiId,
        {
          id: payload.user_id,
          bot_id: payload.bot_id,
          username: payload.username,
          display_name: payload.display_name,
          avatar_url: payload.avatar_url,
        },
        operation,
        isCurrentUser,
        emojiData,
      )
    },
    matchesEmoji: (group, emoji) => matchesEmoji(group, emoji.emojiId),
    hasReacted: (group) => group.current_user_reacted ?? false,
    groupKey: (g) => (g.emoji_id || g.emoji?.name || (g.emoji as any)?.content || 'unknown'),
    emojiKey: (emoji) => emoji.emojiId,
    entityIdFromRealtime: (payload) => payload?.message_id || payload?.new?.message_id || payload?.old?.message_id,
    realtimeReconcileDelayMs: 400,
  })

  const hasUserReacted = computed(() =>
    (messageId: string, emojiId: string, _userId?: string): boolean =>
      engine.hasUserReacted.value(messageId, { emojiId }))

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
