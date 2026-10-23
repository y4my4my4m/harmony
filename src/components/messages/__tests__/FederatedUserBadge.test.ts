// The globe after the name of a user from another instance: shown for a cached profile with
// is_local false, named "From {domain}"; absent for local, uncached and bridged authors.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { computed } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

const users = vi.hoisted(() => ({
  'remote-1': { id: 'remote-1', isLocal: false, domain: 'spacify.cloud' },
  'remote-nodomain': { id: 'remote-nodomain', isLocal: false, domain: undefined },
  'local-1': { id: 'local-1', isLocal: true, domain: 'home.test' },
} as Record<string, { id: string; isLocal: boolean; domain?: string }>))

vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getUser: (id: string) => computed(() => users[id]) }),
}))

import FederatedUserBadge from '../FederatedUserBadge.vue'
import MessageAuthorLabel from '../MessageAuthorLabel.vue'

enableAutoUnmount(afterEach)

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const global = {
  plugins: [i18n],
  stubs: { DisplayName: { props: ['userId', 'fallback'], template: '<span class="dn">{{ fallback }}</span>' }, BridgeSourceBadge: true },
}

const badgeOf = (userId: string | null) => mount(FederatedUserBadge, { props: { userId }, global })
  .find('[data-testid="federated-user-badge"]')

describe('FederatedUserBadge', () => {
  it('shows a globe named after the author\'s instance for a remote profile', () => {
    const badge = badgeOf('remote-1')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('role')).toBe('img')
    expect(badge.attributes('aria-label')).toBe('From spacify.cloud')
    expect(badge.attributes('title')).toBe('From spacify.cloud')
    expect(badge.find('svg').attributes('aria-hidden')).toBe('true')
  })

  it('names a remote profile without a domain a federated user', () => {
    expect(badgeOf('remote-nodomain').attributes('aria-label')).toBe('Federated user')
  })

  it('shows nothing for a local, an uncached or no profile', () => {
    expect(badgeOf('local-1').exists()).toBe(false)
    expect(badgeOf('uncached').exists()).toBe(false)
    expect(badgeOf(null).exists()).toBe(false)
  })
})

describe('MessageAuthorLabel', () => {
  const label = (props: Record<string, unknown>) => mount(MessageAuthorLabel, { props, global })

  it('puts the globe after a remote author\'s name in reply previews', () => {
    const wrapper = label({ profileUserId: 'remote-1', displayName: 'spartzy' })
    const badge = wrapper.get('[data-testid="federated-user-badge"]')
    expect(badge.attributes('aria-label')).toBe('From spacify.cloud')
    expect(wrapper.get('.dn').element.nextElementSibling).toBe(badge.element)
  })

  it('leaves local and bridged authors without the globe', () => {
    expect(label({ profileUserId: 'local-1', displayName: 'local' }).find('[data-testid="federated-user-badge"]').exists()).toBe(false)
    // Bridged authors carry no profile id (getHarmonyProfileUserId).
    const bridged = label({ profileUserId: '', displayName: 'discorder', bridgeSource: 'discord' })
    expect(bridged.find('[data-testid="federated-user-badge"]').exists()).toBe(false)
  })
})
