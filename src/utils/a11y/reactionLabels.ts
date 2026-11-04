// Spoken labels of a message's reactions: each reaction button's name, and the
// row name's reactions part built from those same names.

import type { Emoji, ReactionGroup } from '@/types'
import { customEmojiLabel, spokenEmojiName } from '@/utils/a11y/emojiNames'

type Translate = (key: string, params: Record<string, unknown>, plural?: number) => string

/** unifiedEmojiService resolveEmoji, or a stand-in; null when unresolved. */
export type EmojiResolver = (identifier: string) => { shortcode?: string | null } | null | undefined

type ReactionEmoji = Emoji & { is_native?: boolean; content?: string }

/** The group's emoji as resolveEmoji looks it up: character, name, id, then the group's key. */
export function reactionEmojiIdentifier(group: ReactionGroup): string {
  const emoji = group.emoji as ReactionEmoji | undefined
  if (!emoji) return ''
  return emoji.content || emoji.name || emoji.id || group.emoji_id || ''
}

/** :name: for a custom emoji, the shortcode in words otherwise. */
export function reactionEmojiSpoken(group: ReactionGroup, resolve: EmojiResolver): string {
  const emoji = group.emoji as ReactionEmoji | undefined
  if (emoji?.url && !emoji.is_native) return customEmojiLabel(emoji.name)
  const identifier = reactionEmojiIdentifier(group)
  let shortcode: string | null | undefined
  try {
    shortcode = identifier ? resolve(identifier)?.shortcode : null
  } catch {
    shortcode = null
  }
  return spokenEmojiName({ shortcode, name: emoji?.name, native: emoji?.content }) || group.emoji_id || ''
}

/** "thumbs up, 3 reactions, including you". */
export function reactionPillLabel(group: ReactionGroup, t: Translate, resolve: EmojiResolver): string {
  const params = { emoji: reactionEmojiSpoken(group, resolve), count: group.count }
  return group.current_user_reacted
    ? t('messageA11y.reactions.pillYou', params, group.count)
    : t('messageA11y.reactions.pill', params, group.count)
}

/**
 * "Reactions: thumbs up, 2 reactions, including you; :party:, 1 reaction": the
 * pill labels in pill order. Empty without reactions.
 */
export function reactionsSummary(groups: readonly ReactionGroup[], t: Translate, resolve: EmojiResolver): string {
  if (groups.length === 0) return ''
  const list = groups.map((group) => reactionPillLabel(group, t, resolve)).join('; ')
  return t('messageA11y.reactions.summary', { list })
}
