/**
 * Message content of a server whose media this instance hides renders it hidden outside the
 * channel view too: search results and Today's mentions. A conversation's never does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('@/composables/useMessageAuthorPresentation', () => ({
  useMessageAuthorPresentation: () => ({
    profileUserId: ref('u1'), displayName: ref('U1'), avatarUrl: ref(null), usernameColor: ref('#123456'),
    bridgeSource: ref(null), isBridged: ref(false),
  }),
}))
vi.mock('@/services/instanceServerTools', () => ({ fetchMediaHiddenServerIds: vi.fn(async () => ['copy-1']) }))

const ContentStub = defineComponent({
  name: 'UnifiedMessageContent',
  props: { mediaHidden: { type: Boolean, default: false } },
  setup: (props) => () => h('div', { class: 'content-stub', 'data-media-hidden': String(props.mediaHidden) }),
})

import SearchResultItem from '../search/SearchResultItem.vue'
import TodayMentionRow from '../today/TodayMentionRow.vue'
import { resetInstanceMediaHidden } from '@/composables/useInstanceMediaHidden'

enableAutoUnmount(afterEach)

const stubs = {
  Avatar: true, Icon: true, SupporterBadge: true, MessageAuthorLabel: true, RouterLink: true,
  UnifiedMessageContent: ContentStub,
}

const message = (extra: Record<string, unknown> = {}) => ({
  id: 'm1', user_id: 'u1', created_at: new Date('2026-10-20T00:00:00Z'), metadata: {},
  content: [{ type: 'text', text: 'look' }, { type: 'url', url: 'https://host.test/cat.png' }],
  ...extra,
}) as any

const hiddenFlag = (wrapper: ReturnType<typeof mount>) => wrapper.get('.content-stub').attributes('data-media-hidden')

beforeEach(() => {
  resetInstanceMediaHidden()
})

describe('SearchResultItem', () => {
  it('hides the media of a server this instance hides', async () => {
    const w = mount(SearchResultItem, { props: { message: message({ channel_id: 'c1' }), serverId: 'copy-1' }, global: { stubs } })
    await flushPromises()
    expect(hiddenFlag(w)).toBe('true')
  })

  it('shows the media of another server and of a conversation', async () => {
    const other = mount(SearchResultItem, { props: { message: message({ channel_id: 'c1' }), serverId: 'home-1' }, global: { stubs } })
    const dm = mount(SearchResultItem, { props: { message: message({ conversation_id: 'dm-1' }), serverId: 'copy-1' }, global: { stubs } })
    await flushPromises()
    expect(hiddenFlag(other)).toBe('false')
    expect(hiddenFlag(dm)).toBe('false')
  })
})

describe('TodayMentionRow', () => {
  const mention = (server: { id: string; name: string } | null) => ({
    kind: 'mention', unread: true, message: message(), author: null, server,
    channelName: server ? 'general' : null, threadName: null, conversation: server ? null : { id: 'dm-1', type: 'direct' },
  }) as any

  it('hides the media of a mention in a server this instance hides', async () => {
    const w = mount(TodayMentionRow, { props: { mention: mention({ id: 'copy-1', name: 'Elsewhere' }) }, global: { stubs } })
    await flushPromises()
    expect(hiddenFlag(w)).toBe('true')
  })

  it('shows the media of a mention in a conversation', async () => {
    const w = mount(TodayMentionRow, { props: { mention: mention(null) }, global: { stubs } })
    await flushPromises()
    expect(hiddenFlag(w)).toBe('false')
  })
})
