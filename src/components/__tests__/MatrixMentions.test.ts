/**
 * A mention of a bridged person renders the same way for Discord and Matrix: `@name`, the
 * platform badge, a `Platform: @name` tooltip, and a click that opens the person's card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UnifiedMessageContent from '../UnifiedMessageContent.vue'
import UnifiedContentRenderer from '../UnifiedContentRenderer.vue'
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))

const mentions = {
  discord: { type: 'mention', userId: '123', username: 'sam', domain: 'discord.com', isLocal: false, isBridged: true, bridgeSource: 'discord' },
  matrix: { type: 'mention', userId: '@sam:example.org', username: 'sam', domain: 'example.org', isLocal: false, isBridged: true, bridgeSource: 'matrix', displayName: 'sam' },
} as const
const profileIds = { discord: 'discord:123', matrix: 'matrix:@sam:example.org' }

let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
})
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals() })

describe.each(['discord', 'matrix'] as const)('%s mention', platform => {
  it('shows @name with the platform badge and opens the card in chat', async () => {
    wrapper = shallowMount(UnifiedMessageContent, { props: { content: [mentions[platform]], messageId: 'm', editableContent: '' }, global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    const pill = wrapper.get('.mention')
    expect(pill.text()).toBe('@sam')
    expect(pill.classes()).toContain('bridged-mention')
    expect(pill.attributes('disabled')).toBeUndefined()
    expect(pill.attributes('title')).toBe(`${platform === 'discord' ? 'Discord' : 'Matrix'}: @sam`)
    expect(pill.getComponent({ name: 'BridgeSourceBadge' }).props('source')).toBe(platform)
    expect(wrapper.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
    await pill.trigger('click')
    expect(wrapper.emitted('show-user-profile')?.[0][0]).toBe(profileIds[platform])
  })

  it('renders the same pill in the shared content renderer', async () => {
    wrapper = shallowMount(UnifiedContentRenderer, { props: { content: [mentions[platform]] }, global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    const pill = wrapper.get('.mention')
    expect(pill.text()).toBe('@sam')
    expect(pill.getComponent({ name: 'BridgeSourceBadge' }).props('source')).toBe(platform)
    expect(wrapper.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
    await pill.trigger('click')
    expect(wrapper.emitted('user-mention-click')?.[0][0]).toBe(profileIds[platform])
  })
})

describe('Matrix mention name', () => {
  it('shows a display name the part carries, else the MXID localpart, never the MXID', async () => {
    wrapper = shallowMount(UnifiedMessageContent, {
      props: { content: [{ ...mentions.matrix, displayName: 'Sam Smith' }, { ...mentions.matrix, displayName: undefined, bridgeSource: undefined, isBridged: undefined }], messageId: 'm', editableContent: '' },
      global: { mocks: { $t: (key: string) => key } },
    })
    await flushPromises()
    expect(wrapper.findAll('.mention').map(pill => pill.text())).toEqual(['@Sam Smith', '@sam'])
    expect(wrapper.text()).not.toContain('example.org')
  })
})
