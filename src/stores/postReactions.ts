import { defineStore } from 'pinia'
import { computed } from 'vue'
import { supabase } from '@/supabase'
import { useProfileStore } from '@/stores/useProfile'
import { createReactionEngine } from '@/stores/shared/reactionEngine'

export interface PostReactionGroup {
  emoji_id: string | null
  emoji_name: string | null
  emoji_url: string | null
  custom_emoji_content: string | null
  reaction_count: number
  user_reactions: Array<{
    user_id: string
    username: string
    display_name: string
    avatar_url: string
    created_at: string
  }>
  current_user_reacted: boolean
}

/** Emoji input for a post reaction toggle. */
interface PostReactionInput {
  id?: string
  native?: string
  name?: string
  url?: string
}

const isUuid = (str: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)

function matchesEmoji(group: PostReactionGroup, emoji: PostReactionInput): boolean {
  return !!(
    (emoji.id && group.emoji_id === emoji.id) ||
    (emoji.native && group.custom_emoji_content === emoji.native)
  )
}

/**
 * Build the optimistic group array for a post reaction toggle. Deep-clones the
 * base so we never mutate cached real data, keeps `current_user_reacted` +
 * `reaction_count` accurate, and leaves `user_reactions` to the reconcile fetch
 * (so tooltips don't flash partial data).
 */
function buildOptimisticGroups(
  base: PostReactionGroup[],
  emoji: PostReactionInput,
  operation: 'add' | 'remove',
): PostReactionGroup[] {
  const result = JSON.parse(JSON.stringify(base)) as PostReactionGroup[]
  const emojiId = emoji.id || null
  const customContent = emoji.native || null
  const index = result.findIndex(matchesEmojiBy(emojiId, customContent))

  if (operation === 'remove') {
    if (index >= 0) {
      const existing = result[index]
      existing.reaction_count = Math.max(0, existing.reaction_count - 1)
      existing.current_user_reacted = false
      if (existing.reaction_count === 0) result.splice(index, 1)
    }
  } else {
    if (index >= 0) {
      const existing = result[index]
      existing.reaction_count += 1
      existing.current_user_reacted = true
    } else {
      result.push({
        emoji_id: emojiId,
        emoji_name: emoji.name || null,
        emoji_url: emoji.url || null,
        custom_emoji_content: customContent,
        reaction_count: 1,
        user_reactions: [],
        current_user_reacted: true,
      })
    }
  }

  return result
}

const matchesEmojiBy = (emojiId: string | null, customContent: string | null) =>
  (g: PostReactionGroup): boolean =>
    !!((emojiId && g.emoji_id === emojiId) || (customContent && g.custom_emoji_content === customContent))

const USER_LIMIT = 5

export const usePostReactionsStore = defineStore('postReactions', () => {
  const engine = createReactionEngine<PostReactionGroup, PostReactionInput>({
    async fetchBatch(postIds) {
      if (postIds.length === 1) {
        const { data, error } = await supabase.rpc('get_post_emoji_reactions', {
          p_post_id: postIds[0],
          p_user_limit: USER_LIMIT,
        })
        if (error) throw error
        return { [postIds[0]]: (data || []) as PostReactionGroup[] }
      }

      const { data, error } = await supabase.rpc('get_batch_post_emoji_reactions', {
        p_post_ids: postIds,
        p_user_limit: USER_LIMIT,
      })
      if (error) throw error

      const grouped: Record<string, PostReactionGroup[]> = {}
      for (const r of (data || []) as any[]) {
        ;(grouped[r.post_id] ||= []).push({
          emoji_id: r.emoji_id,
          emoji_name: r.emoji_name,
          emoji_url: r.emoji_url,
          custom_emoji_content: r.custom_emoji_content,
          reaction_count: r.reaction_count,
          user_reactions: r.user_reactions || [],
          current_user_reacted: r.current_user_reacted,
        })
      }
      return grouped
    },
    async toggleOnServer(postId, emoji, currentlyReacted) {
      const userId = useProfileStore().profileId
      if (!userId) throw new Error('Not authenticated')

      const emojiIsUuid = !!emoji.id && isUuid(emoji.id)
      const emojiId = emojiIsUuid ? emoji.id : null
      const customContent = emoji.native || (!emojiIsUuid ? (emoji.id || emoji.name) : null)

      const { error } = await supabase.rpc(
        currentlyReacted ? 'remove_post_emoji_reaction' : 'add_post_emoji_reaction',
        { p_user_id: userId, p_post_id: postId, p_emoji_id: emojiId, p_custom_emoji_content: customContent },
      )
      if (error) throw error
      // Federation is handled server-side by the post_interactions DB trigger
      // (-> BullMQ -> resolveOutboundEmoji, domain-qualified custom emoji).
    },
    applyOptimistic: (base, emoji, operation) => buildOptimisticGroups(base, emoji, operation),
    matchesEmoji,
    hasReacted: (group) => group.current_user_reacted,
    groupKey: (g) => g.emoji_id || g.custom_emoji_content || g.emoji_name || 'unknown',
    emojiKey: (emoji) => emoji.id || emoji.native || emoji.name || 'unknown',
    entityIdFromRealtime: (payload) => payload?.new?.post_id || payload?.old?.post_id,
  })

  const hasUserReacted = computed(() =>
    (postId: string, emojiId: string | null, customContent: string | null): boolean =>
      engine.hasUserReacted.value(postId, { id: emojiId || undefined, native: customContent || undefined }))

  return {
    reactionsByPost: engine.reactionsByEntity,
    getPostReactions: engine.getReactions,
    isLoadingReactions: engine.isLoadingReactions,
    hasUserReacted,

    fetchPostReactions: (postId: string, force = false) => engine.fetch(postId, force),
    fetchMultiplePostReactions: (postIds: string[], force = false) => engine.fetchMultiple(postIds, force),

    toggleReaction: (postId: string, emoji: PostReactionInput, _userId?: string) =>
      engine.toggle(postId, emoji),

    handleRealtimeUpdate: engine.handleRealtimeUpdate,
    clearOptimisticState: engine.clearOptimisticState,
    bulkSetReactions: engine.bulkSet,
    $dispose: engine.dispose,
  }
})
