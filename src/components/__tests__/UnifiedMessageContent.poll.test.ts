/**
 * A poll message renders its card alone; the text part spelling the poll out is for
 * text-only readers.
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const POLL = { type: 'poll', pollId: 'p1', question: 'Lunch?', options: ['Pizza', 'Sushi'] }

async function render(content: unknown[]) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '' },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

describe('UnifiedMessageContent polls', () => {
  it('renders the poll card and hides the spelled-out text', async () => {
    const w = await render([POLL, { type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Sushi' }])
    const card = w.findComponent({ name: 'PollCard' })
    expect(card.exists()).toBe(true)
    expect(card.props('poll')).toEqual(POLL)
    expect(card.props('messageId')).toBe('m1')
    expect(w.text()).not.toContain('1. Pizza')
  })

  it('renders text messages as before', async () => {
    const w = await render([{ type: 'text', text: '1. Pizza' }])
    expect(w.findComponent({ name: 'PollCard' }).exists()).toBe(false)
    expect(w.text()).toContain('Pizza')
  })
})
