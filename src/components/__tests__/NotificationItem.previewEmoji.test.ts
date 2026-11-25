import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { shallowReactive } from 'vue'

// The preview the server wrote holds no custom emojis; the row draws those of the message itself.

const shared = vi.hoisted(() => ({ requested: [] as string[] }))
const rows = shallowReactive(new Map<string, unknown>())
vi.mock('@/services/previewContent', () => ({
  requestPreviewContent: (kind: string, id: string) => shared.requested.push(`${kind}:${id}`),
  previewContent: (kind: string, id: string) => rows.get(`${kind}:${id}`) ?? null,
}))
vi.mock('@/components/DisplayName.vue', () => ({ default: { template: '<span class="actor" />' } }))
vi.mock('@/components/common/Avatar.vue', () => ({ default: { template: '<span />' } }))
vi.mock('@/components/common/Icon.vue', () => ({ default: { template: '<i />' } }))
vi.mock('@/components/common/TwemojiText.vue', () => ({ default: { props: ['text'], template: '<span>{{ text }}</span>' } }))

const NotificationItem = (await import('../NotificationItem.vue')).default
const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false })
const pog = { type: 'emoji', emoji: { id: 'e', name: 'pog', url: 'https://remote.example/pog.png' } }
const text = (value: string) => ({ type: 'text', text: value })

const row = (type: string, data: Record<string, unknown>) => mount(NotificationItem, {
  global: { plugins: [i18n] },
  props: { now: new Date(), notification: { id: 'n', type, is_read: false, created_at: new Date().toISOString(), data: { sender: { display_name: 'Ann' }, ...data } } as any },
})
const preview = (wrapper: ReturnType<typeof row>) => wrapper.get('[data-testid="notification-preview"]')

describe('NotificationItem preview', () => {
  beforeEach(() => {
    rows.clear()
    shared.requested.length = 0
  })

  it('draws the emojis of the message once it was read, and names them for screen readers', async () => {
    const wrapper = row('mention', { message: { id: 'm1', content_preview: 'lets update' } })
    expect(shared.requested).toEqual(['message:m1'])
    expect(preview(wrapper).text()).toBe('lets update')
    rows.set('message:m1', [text('lets update '), pog])
    await wrapper.vm.$nextTick()
    expect(preview(wrapper).get('img').attributes()).toMatchObject({ src: pog.emoji.url, alt: ':pog:' })
    expect(preview(wrapper).text()).toBe('lets update')
    expect(wrapper.get('[data-row-hit]').attributes('aria-label')).toContain('lets update :pog:')
  })

  it('draws a message of emojis alone, whose stored preview says only that there is one', async () => {
    const wrapper = row('dm', { message: { id: 'm2', content_preview: 'New message' } })
    rows.set('message:m2', [pog, pog])
    await wrapper.vm.$nextTick()
    expect(preview(wrapper).findAll('img')).toHaveLength(2)
    expect(preview(wrapper).text()).toBe('')
  })

  it('reads the message reacted to and the post of a social row', () => {
    row('reaction', { message_id: 'm3', message_preview: 'hello', reaction: { emoji_name: '🔥' } })
    row('activitypub_favorite', { post: { id: 'p1', content_preview: 'a post' } })
    expect(shared.requested).toEqual(['message:m3', 'post:p1'])
  })

  it('reads nothing of an encrypted message', () => {
    const wrapper = row('mention', { encrypted: true, message: { id: 'm4', content_preview: 'x' } })
    expect(shared.requested).toEqual([])
    expect(preview(wrapper).text()).toBe('Encrypted message')
  })

  it('keeps the stored preview of a message without custom emojis, its spoilers covered', () => {
    expect(preview(row('mention', { message: { id: 'm5', content_preview: 'see ||the end|| here' } })).text()).toMatch(/^see ▒+ here$/)
  })

  it('cuts a long message as the server does', async () => {
    const wrapper = row('mention', { message: { id: 'm6', content_preview: 'x' } })
    rows.set('message:m6', [text('y'.repeat(300)), pog])
    await wrapper.vm.$nextTick()
    expect(preview(wrapper).text()).toBe(`${'y'.repeat(100)}…`)
  })
})
