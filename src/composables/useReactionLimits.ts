import { computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { matchesMessageReactionGroup, useReactionsStore } from '@/stores/useReactions'
import { matchesPostReactionGroup, usePostReactionsStore } from '@/stores/postReactions'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import {
  MESSAGE_REACTION_KINDS,
  messageEmojiBlocked,
  ownPostReactions,
  postEmojiBlocked,
  type PickedEmoji,
} from '@/utils/reactionLimits'

/** Picker props for a message's reaction limit: 20 different emoji. */
export function useMessageReactionLimit(messageId: Ref<string | null | undefined>) {
  const { t } = useI18n()
  const reactionsStore = useReactionsStore()

  const groups = computed(() => (messageId.value ? reactionsStore.getMessageReactions(messageId.value) : []))

  const isEmojiBlocked = (emoji: PickedEmoji): boolean =>
    messageEmojiBlocked(groups.value, emoji, matchesMessageReactionGroup)

  const limitNotice = computed(() =>
    groups.value.length >= MESSAGE_REACTION_KINDS
      ? t('emoji.messageReactionLimit', { count: MESSAGE_REACTION_KINDS })
      : null)

  return { isEmojiBlocked, limitNotice }
}

/** Picker props for the current user's per-post reaction limit. */
export function usePostReactionLimit(postId: Ref<string | null | undefined>) {
  const { t } = useI18n()
  const postReactionsStore = usePostReactionsStore()
  const instanceSettings = useInstanceSettingsStore()

  const groups = computed(() => (postId.value ? postReactionsStore.getPostReactions(postId.value) : []))
  const limit = computed(() => instanceSettings.settings.maxPostReactionsPerUser)

  const isEmojiBlocked = (emoji: PickedEmoji): boolean =>
    postEmojiBlocked(groups.value, emoji, limit.value, matchesPostReactionGroup)

  const limitNotice = computed(() =>
    ownPostReactions(groups.value).length >= limit.value
      ? t('emoji.postReactionLimit', { count: limit.value })
      : null)

  return { isEmojiBlocked, limitNotice }
}
