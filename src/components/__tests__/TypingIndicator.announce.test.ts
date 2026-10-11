/**
 * Typing is a verbose announcement: spoken only with "Screen reader support" on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { THROTTLE_MS, WRITE_DELAY_MS, announcerRegions, resetAnnouncer, setVerboseAnnouncements } from '@/composables/useAnnouncer'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => (key === 'message.typing.single' ? ' is typing...' : key) }) }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getUserDisplayName: (id: string) => ref(id === 'u1' ? 'Alice' : id) }),
}))

import TypingIndicator from '../TypingIndicator.vue'

const { politeText } = announcerRegions()
const settle = () => vi.advanceTimersByTime(THROTTLE_MS + WRITE_DELAY_MS + 1)

beforeEach(() => {
  vi.useFakeTimers()
  resetAnnouncer()
})

afterEach(() => {
  setVerboseAnnouncements(false)
  resetAnnouncer()
  vi.useRealTimers()
})

describe('TypingIndicator announcements', () => {
  it('speaks who is typing when screen reader support is on', async () => {
    setVerboseAnnouncements(true)
    const wrapper = mount(TypingIndicator, { props: { typingUsers: [] }, global: { stubs: { DisplayName: true } } })
    await wrapper.setProps({ typingUsers: [{ user_id: 'u1' }] as never })
    settle()
    expect(politeText.value).toBe('Alice is typing...')
  })

  it('stays silent otherwise', async () => {
    const wrapper = mount(TypingIndicator, { props: { typingUsers: [] }, global: { stubs: { DisplayName: true } } })
    await wrapper.setProps({ typingUsers: [{ user_id: 'u1' }] as never })
    settle()
    expect(politeText.value).toBe('')
  })
})
