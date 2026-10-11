/**
 * Onboarding server suggestions: the joining state is in the button's name and
 * aria-busy, "Joining {server}…" is announced when the join starts and
 * "Joined {server}" once the server is in the member's list.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { Server } from '@/types'

const { polite, translate } = vi.hoisted(() => ({
  polite: vi.fn(),
  translate: (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))

vi.mock('@/composables/useAnnouncer', () => ({
  useAnnouncer: () => ({ polite, assertive: vi.fn(), announce: vi.fn() }),
}))
vi.mock('@/composables/useT', () => ({ useT: () => ({ t: translate, locale: { value: 'en' } }) }))

import OnboardingServerSuggestions from '../OnboardingServerSuggestions.vue'

const global = {
  stubs: { Icon: true, ServerIcon: true },
  mocks: { $t: translate },
}

const hall = { id: 'hall', name: 'Town Hall', description: '', icon: null, banner: null, member_count: 83 }
const club = { id: 'club', name: 'Book Club', description: '', icon: null, banner: null, member_count: 9 }

beforeEach(() => {
  setActivePinia(createPinia())
  polite.mockClear()
})

function mountList() {
  return mount(OnboardingServerSuggestions, {
    props: { servers: [hall, club], source: 'featured', instanceName: 'Harmony', joiningId: null },
    global,
  })
}

describe('OnboardingServerSuggestions joining state', () => {
  it('names each join button after its server', () => {
    const w = mountList()
    const names = w.findAll('[data-testid="onboarding-join"]').map((b) => b.attributes('aria-label'))
    expect(names).toEqual([
      'welcomeServer.joinNamed {"server":"Town Hall"}',
      'welcomeServer.joinNamed {"server":"Book Club"}',
    ])
  })

  it('puts joining in the name and busy state, and announces it', async () => {
    const w = mountList()
    await w.setProps({ joiningId: 'hall' })
    const [joining, other] = w.findAll('[data-testid="onboarding-join"]')
    expect(joining.attributes('aria-label')).toBe('welcomeServer.joiningNamed {"server":"Town Hall"}')
    expect(joining.attributes('aria-busy')).toBe('true')
    expect(joining.attributes('aria-disabled')).toBe('true')
    expect(joining.attributes('disabled')).toBeUndefined()
    expect(other.attributes('disabled')).toBeDefined()
    expect(polite).toHaveBeenCalledWith('welcomeServer.joiningNamed {"server":"Town Hall"}')
  })

  it('announces Joined once the server is in the member list', async () => {
    const w = mountList()
    await w.setProps({ joiningId: 'hall' })
    useServerChannelStore().servers = [{ id: 'hall', name: 'Town Hall' } as Server]
    await w.setProps({ joiningId: null })
    expect(polite).toHaveBeenLastCalledWith('welcomeServer.joinedNamed {"server":"Town Hall"}')
  })

  it('announces Joined when a successful join unmounts the list first', async () => {
    const w = mountList()
    await w.setProps({ joiningId: 'hall' })
    useServerChannelStore().servers = [{ id: 'hall', name: 'Town Hall' } as Server]
    w.unmount()
    expect(polite).toHaveBeenLastCalledWith('welcomeServer.joinedNamed {"server":"Town Hall"}')
  })

  it('says nothing more when the join failed', async () => {
    const w = mountList()
    await w.setProps({ joiningId: 'hall' })
    polite.mockClear()
    await w.setProps({ joiningId: null })
    expect(polite).not.toHaveBeenCalled()
  })
})
