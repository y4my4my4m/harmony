import { defineStore } from 'pinia'
import { computed } from 'vue'
import { services } from '@/services'
import type { ReactionGroup, ReactionActor, Emoji } from '@/types'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useProfileStore } from '@/stores/useProfile'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'
import { createReactionEngine } from '@/stores/shared/reactionEngine'

interface MessageReactionInput {
  emojiId: string
  emojiData?: Emoji
}

/** Identity a reaction is attributed to (current user, remote user, or bot). */
type ActorInput = Pick<ReactionActor, 'bot_id' | 'username' | 'display_name' | 'avatar_url' | 'metadata'> & {
  id?: string | null
}

const isUuid = (str: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)

const actorKey = (actor: ActorInput): string =>
  actor.metadata?.discord_user?.id || actor.id || actor.bot_id || ''

const reactionKey = (r: ReactionActor): string =>
  r.metadata?.discord_user?.id || r.user_id || r.bot_id || r.reaction_id || ''

function matchesEmoji(group: ReactionGroup, emojiId: string): boolean {
  return isUuid(emojiId)
    ? group.emoji_id === emojiId
    : !group.emoji_id && group.emoji?.name === emojiId
}

function makeReactionEntry(actor: ActorInput, reactionId?: string): ReactionActor {
  return {
    reaction_id: reactionId || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user_id: actor.id ?? undefined,
    bot_id: actor.bot_id ?? undefined,
    username: actor.username,
    display_name: actor.display_name,
    avatar_url: actor.avatar_url,
    metadata: actor.metadata,
  }
}

function resolveEmojiForGroup(emojiId: string, providedEmojiData?: Emoji): Emoji {
  // Custom emoji are keyed by emoji_id, so the display name doesn't affect
  // matching. Use the caller's data, backfilling the url from cache so the chip
  // image renders instantly even when the caller (e.g. a frequent pick) omits it.
  if (isUuid(emojiId)) {
    const cached = useEmojiCacheStore().getEmojiById(emojiId)
    if (providedEmojiData) {
      return providedEmojiData.url || !cached ? providedEmojiData : { ...providedEmojiData, url: cached.url }
    }
    return cached ?? ({ id: emojiId, name: 'unknown', url: '', server_id: '', uploader: '', usage_count: 0 } as Emoji)
  }

  // Unicode/shortcode: the server stores the raw id in custom_emoji_content and
  // echoes it as both emoji.name and emoji.content. The optimistic group must
  // match that (not the display name like "thumbs up") so matchesEmoji/groupKey
  // stay stable through reconcile - otherwise the chip can't toggle off and
  // jumps position when the server row arrives.
  const resolved = useUnifiedEmoji().resolveEmoji(emojiId)
  return {
    id: emojiId,
    name: emojiId,
    content: emojiId,
    url: providedEmojiData?.url || (resolved.display.type === 'svg' ? resolved.display.content : ''),
    native: resolved.unicode,
    unicode: resolved.unicode,
    server_id: '',
    uploader: '',
    usage_count: 0,
  } as Emoji
}

function buildOptimisticGroups(
  base: ReactionGroup[],
  emojiId: string,
  actor: ActorInput,
  operation: 'add' | 'remove',
  isCurrentUser: boolean,
  providedEmojiData?: Emoji,
  reactionId?: string,
): ReactionGroup[] {
  const result = JSON.parse(JSON.stringify(base)) as ReactionGroup[]
  const index = result.findIndex(g => matchesEmoji(g, emojiId))
  const key = actorKey(actor)

  if (operation === 'remove') {
    if (index >= 0) {
      const group = result[index]
      group.reactions = (group.reactions ?? []).filter(r => reactionKey(r) !== key)
      group.count = Math.max(0, (group.count || 1) - 1)
      if (isCurrentUser) group.current_user_reacted = false
      if (group.count === 0) result.splice(index, 1)
    }
    return result
  }

  if (index >= 0) {
    const group = result[index]
    group.reactions = group.reactions ?? []
    if (!group.reactions.some(r => reactionKey(r) === key)) {
      group.reactions.push(makeReactionEntry(actor, reactionId))
      group.count = (group.count || 0) + 1
      if (isCurrentUser) group.current_user_reacted = true
    }
    return result
  }

  result.push({
    emoji_id: isUuid(emojiId) ? emojiId : null,
    emoji: resolveEmojiForGroup(emojiId, providedEmojiData),
    count: 1,
    current_user_reacted: isCurrentUser,
    reactions: [makeReactionEntry(actor, reactionId)],
  })
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
      const metadata = payload.metadata ?? undefined
      const discordUserId = metadata?.discord_user?.id as string | undefined
      // Custom (server) emoji carry name/url in the payload so a brand-new chip
      // renders even when this client hasn't cached the emoji.
      const emojiData = payload.emoji_id
        ? ({ id: payload.emoji_id, name: payload.emoji_name, url: payload.emoji_url } as Emoji)
        : payload.emoji_url
          ? ({ id: emojiId, name: payload.emoji_name || emojiId, url: payload.emoji_url } as Emoji)
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
          metadata,
        },
        operation,
        isCurrentUser,
        emojiData,
        discordUserId ? payload.reaction_id : undefined,
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
