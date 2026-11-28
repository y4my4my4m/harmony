/** The line above a reply draws custom emojis, of this instance and of another, and names one that does not load. */
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewRun } from '@/utils/previewRuns'

const shared = vi.hoisted(() => ({ runs: [] as unknown[] }))
vi.mock('@/composables/useReplyTarget', () => ({
  useReplyTarget: () => ({
    profileUserId: ref(null), authorLabel: ref('Ann'), bridgeSource: ref(null), avatarUrl: ref(''), usernameColor: ref(undefined),
    previewRuns: computed(() => shared.runs as PreviewRun[]),
  }),
}))
vi.mock('@/composables/useT', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string, size: number) => `${url}?size=${size}` }))
vi.mock('@/components/common/Avatar.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/messages/MessageAuthorLabel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/common/TwemojiText.vue', () => ({ default: { props: ['text'], template: '<span class="text">{{ text }}</span>' } }))

import MessageReplyReference from '../MessageReplyReference.vue'

const pog = { name: 'pog', url: 'https://remote.example/pog.png' }
const render = () => mount(MessageReplyReference, { props: { replyToMessageId: 'm1', channelId: 'c1' } })

describe('MessageReplyReference', () => {
  beforeEach(() => {
    shared.runs = [{ text: 'alright ', emoji: null }, { text: '', emoji: pog }, { text: ' go', emoji: null }]
  })

  it('draws a custom emoji between its text, named for screen readers', () => {
    const preview = render().get('[data-testid="reply-preview"]')
    const image = preview.get('img')
    expect(image.attributes()).toMatchObject({ src: `${pog.url}?size=48`, alt: ':pog:', title: ':pog:' })
    expect(preview.text()).not.toContain(':pog:')
    expect(preview.findAll('.text').map((run) => run.text())).toEqual(['alright', 'go'])
  })

  it('names an emoji that does not load, and the same one elsewhere on the line', async () => {
    shared.runs = [...shared.runs, { text: '', emoji: pog }]
    const wrapper = render()
    await wrapper.findAll('img')[0].trigger('error')
    expect(wrapper.findAll('img')).toHaveLength(0)
    expect(wrapper.findAll('.text').map((run) => run.text())).toEqual(['alright', ':pog:', 'go', ':pog:'])
  })
})
