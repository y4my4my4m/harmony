import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'

// The banner's status region exists before any banner does, so "Reconnecting…"
// written into it is announced; a region inserted with its text is not,
// reliably.

const h = vi.hoisted(() => ({ store: null as any }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/components/common/Icon.vue', () => ({ __esModule: true, default: { name: 'Icon', render: () => null } }))

import VoiceCallBanner from '../VoiceCallBanner.vue'

describe('VoiceCallBanner', () => {
  it('keeps one status region mounted and writes the reconnecting text into it', async () => {
    h.store = reactive({ isConnected: true, connectionState: 'connected', audioPlaybackBlocked: false, unlockAudio: vi.fn() })
    const wrapper = mount(VoiceCallBanner)
    const region = wrapper.find('[role="status"]')
    expect(region.exists()).toBe(true)
    expect(region.text()).toBe('')

    h.store.connectionState = 'reconnecting'
    await nextTick()
    expect(wrapper.find('[role="status"]').element).toBe(region.element)
    expect(region.text()).toContain('voice.reconnecting')

    h.store.connectionState = 'connected'
    await nextTick()
    expect(wrapper.find('[role="status"]').element).toBe(region.element)
    expect(region.text()).toBe('')
    wrapper.unmount()
  })
})
