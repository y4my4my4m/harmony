import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UnifiedMessageContent from '../UnifiedMessageContent.vue'
import UnifiedContentRenderer from '../UnifiedContentRenderer.vue'
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))
const mention = { type: 'mention', userId: '@sam:example.org', username: 'sam', domain: 'example.org', isLocal: false, isBridged: true, bridgeSource: 'matrix' }
let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
})
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals() })
describe('Matrix mention surfaces', () => {
  it('shows the native MXID in chat without Harmony profile rendering or actions', async () => {
    wrapper = shallowMount(UnifiedMessageContent, { props: { content: [mention], messageId: 'matrix', editableContent: '' }, global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    expect(wrapper.get('.mention').text()).toContain('@sam:example.org')
    expect(wrapper.get('.mention').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.mention').attributes('title')).toBe('Matrix: @sam:example.org')
    expect(wrapper.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
    await wrapper.get('.mention').trigger('click')
    expect(wrapper.emitted('show-user-profile')).toBeUndefined()
  })
  it('does not route a Matrix MXID to a native profile if older structured parts omit bridge flags', async () => {
    wrapper = shallowMount(UnifiedMessageContent, { props: { content: [{ ...mention, isBridged: undefined, bridgeSource: undefined }], messageId: 'matrix', editableContent: '' }, global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    expect(wrapper.get('.mention').attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
  })
  it('preserves the legacy Discord profile route and compact display', async () => {
    wrapper = shallowMount(UnifiedMessageContent, { props: { content: [{ ...mention, userId: '123', domain: 'discord.com', bridgeSource: 'discord' }], messageId: 'discord', editableContent: '' }, global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    expect(wrapper.get('.mention').text()).toBe('@sam')
    expect(wrapper.get('.mention').attributes('disabled')).toBeUndefined()
    await wrapper.get('.mention').trigger('click')
    expect(wrapper.emitted('show-user-profile')?.[0][0]).toBe('discord:123')
  })
  it('keeps Matrix mentions read-only in the shared content renderer too', async () => {
    wrapper = shallowMount(UnifiedContentRenderer, { props: { content: [mention] }, global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    expect(wrapper.get('.mention').text()).toContain('@sam:example.org')
    expect(wrapper.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
    await wrapper.get('.mention').trigger('click')
    expect(wrapper.emitted('user-mention-click')).toBeUndefined()
  })
})
