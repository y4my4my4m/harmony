import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, args?: Record<string, unknown>) => `${key}:${JSON.stringify(args ?? {})}` }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key } }),
}))

import {
  MESSAGE_REACTION_KINDS,
  isReactionLimitError,
  messageEmojiBlocked,
  postEmojiBlocked,
} from '@/utils/reactionLimits'
import { matchesMessageReactionGroup, useReactionsStore } from '@/stores/useReactions'
import { matchesPostReactionGroup, usePostReactionsStore } from '@/stores/postReactions'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useMessageReactionLimit, usePostReactionLimit } from '@/composables/useReactionLimits'

const UUID = '00000000-0000-4000-8000-0000000000e1'
const unicode = (n: number) => String.fromCodePoint(0x1f600 + n)

const messageGroups = (kinds: number) => Array.from({ length: kinds }, (_, i) => ({
  emoji_id: i === 0 ? UUID : null,
  emoji: { id: i === 0 ? UUID : unicode(i), name: i === 0 ? 'blobcat' : unicode(i) },
  count: 1,
  current_user_reacted: false,
  reactions: [],
})) as any[]

const postGroup = (content: string, mine: boolean) => ({
  emoji_id: null, emoji_name: null, emoji_url: null, custom_emoji_content: content,
  reaction_count: 1, user_reactions: [], current_user_reacted: mine,
})

describe('isReactionLimitError', () => {
  it('recognises the database refusal as an error or a reason string', () => {
    expect(isReactionLimitError({ message: 'REACTION_LIMIT: 20 different emoji per message', code: '23514' })).toBe(true)
    expect(isReactionLimitError('REACTION_LIMIT: 10 reactions per person on a post')).toBe(true)
    expect(isReactionLimitError({ message: 'duplicate key' })).toBe(false)
    expect(isReactionLimitError(undefined)).toBe(false)
  })
})

describe('message limit: twenty different emoji', () => {
  it('takes any emoji below twenty', () => {
    expect(messageEmojiBlocked(messageGroups(MESSAGE_REACTION_KINDS - 1), { id: '🚀' }, matchesMessageReactionGroup)).toBe(false)
  })

  it('at twenty refuses a new emoji and takes a held one, custom or unicode', () => {
    const groups = messageGroups(MESSAGE_REACTION_KINDS)
    expect(messageEmojiBlocked(groups, { id: '🚀' }, matchesMessageReactionGroup)).toBe(true)
    expect(messageEmojiBlocked(groups, { id: unicode(3) }, matchesMessageReactionGroup)).toBe(false)
    expect(messageEmojiBlocked(groups, { id: UUID, url: 'https://x.test/b.png' }, matchesMessageReactionGroup)).toBe(false)
  })
})

describe('post limit: different emoji per person', () => {
  const mine = ['😀', '😁', '😂']
  const groups = [...mine.map((e) => postGroup(e, true)), postGroup('🚀', false)]

  it('takes anything below the limit', () => {
    expect(postEmojiBlocked(groups, { id: '🎉' }, 4, matchesPostReactionGroup)).toBe(false)
  })

  it('at the limit refuses an emoji the person does not hold, someone else\'s included', () => {
    expect(postEmojiBlocked(groups, { id: '🎉' }, 3, matchesPostReactionGroup)).toBe(true)
    expect(postEmojiBlocked(groups, { id: '🚀' }, 3, matchesPostReactionGroup)).toBe(true)
  })

  it('at the limit takes a held emoji, which removes it, and the heart', () => {
    expect(postEmojiBlocked(groups, { id: '😁' }, 3, matchesPostReactionGroup)).toBe(false)
    expect(postEmojiBlocked(groups, { id: '❤️' }, 3, matchesPostReactionGroup)).toBe(false)
  })
})

describe('picker props', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('a message at twenty kinds shows the notice and blocks new emoji', () => {
    useReactionsStore().bulkSetReactions({ m1: messageGroups(MESSAGE_REACTION_KINDS), m2: messageGroups(3) })
    const id = ref('m1')
    const { isEmojiBlocked, limitNotice } = useMessageReactionLimit(id)

    expect(limitNotice.value).toBe('emoji.messageReactionLimit:{"count":20}')
    expect(isEmojiBlocked({ id: '🚀' })).toBe(true)
    expect(isEmojiBlocked({ id: unicode(2) })).toBe(false)

    id.value = 'm2'
    expect(limitNotice.value).toBeNull()
    expect(isEmojiBlocked({ id: '🚀' })).toBe(false)
  })

  it('a post follows the instance limit', () => {
    usePostReactionsStore().bulkSetReactions({ p1: ['😀', '😁'].map((e) => postGroup(e, true)) as any })
    const settings = useInstanceSettingsStore()
    settings.settings.maxPostReactionsPerUser = 2
    const { isEmojiBlocked, limitNotice } = usePostReactionLimit(ref('p1'))

    expect(limitNotice.value).toBe('emoji.postReactionLimit:{"count":2}')
    expect(isEmojiBlocked({ id: '🎉' })).toBe(true)

    settings.settings.maxPostReactionsPerUser = 10
    expect(limitNotice.value).toBeNull()
    expect(isEmojiBlocked({ id: '🎉' })).toBe(false)
  })
})
