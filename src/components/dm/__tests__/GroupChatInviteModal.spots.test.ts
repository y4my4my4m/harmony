/**
 * GroupChatInviteModal.vue: the spots left in a group of 10. The viewer counts once whether or not
 * the caller lists them, matched by profile id, which differs from the auth user id for some accounts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import { conversationOthers } from '@/utils/groupConversation'

const PROFILE = 'profile-viewer'

const mocks = vi.hoisted(() => ({
  createOrGetConversation: vi.fn(async () => 'conversation'),
  addUsersToConversation: vi.fn(async () => true),
  excluded: null as null | (() => Iterable<string | null | undefined>),
  results: null as any,
}))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => mocks }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'auth-viewer' } } }) }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getCurrentUser: ref({ id: PROFILE, username: 'viewer', displayName: 'Viewer', avatarUrl: '' }) }),
}))
vi.mock('@/composables/useUserSearch', () => ({
  useUserSearch: (options: { exclude: () => Iterable<string | null | undefined> }) => {
    mocks.excluded = options.exclude
    mocks.results = ref([])
    return { query: ref('x'), results: mocks.results, searching: ref(false), error: ref(null), clear: vi.fn() }
  },
}))
vi.mock('@/services/AutoModService', () => ({ notifyModerationRejection: () => false }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

import GroupChatInviteModal from '../GroupChatInviteModal.vue'

const person = (id: string) => ({ id, username: id, is_local: true })
const people = (count: number) => Array.from({ length: count }, (_, i) => person(`person-${i}`))

const render = (props: Record<string, unknown>) => shallowMount(GroupChatInviteModal, {
  props: { show: true, ...props },
  global: {
    plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
    stubs: { BaseModal: { template: '<div><slot /><slot name="footer" /></div>' } },
  },
})
const spots = (w: ReturnType<typeof render>) => w.get('[data-testid="group-invite-spots"]').text()

beforeEach(() => { mocks.createOrGetConversation.mockClear(); mocks.addUsersToConversation.mockClear() })

describe('spots left', () => {
  it('is nine for a new group', () => {
    expect(spots(render({}))).toBe('9 spots left')
  })

  it('counts a direct conversation as its two people', () => {
    const existingParticipants = conversationOthers({ type: 'direct', other_user: person('partner') })
    expect(spots(render({ conversationId: 'c', existingParticipants }))).toBe('8 spots left')
  })

  it('counts the viewer once whether or not the caller lists them', () => {
    const listed = render({ conversationId: 'c', existingParticipants: [person(PROFILE), ...people(4)] })
    const unlisted = render({ conversationId: 'c', existingParticipants: people(4) })
    expect(spots(listed)).toBe('5 spots left')
    expect(spots(unlisted)).toBe('5 spots left')
    for (const wrapper of [listed, unlisted]) {
      expect(wrapper.get('.existing-participants-section').text()).toContain('Current participants (5)')
      expect(wrapper.findAll('.you-badge')).toHaveLength(1)
    }
  })

  it('is none in a full group, whose picker takes nobody', async () => {
    const existingParticipants = conversationOthers({ type: 'group', participants: people(9) })
    const wrapper = render({ conversationId: 'c', existingParticipants })
    expect(spots(wrapper)).toBe('This group is full: a group holds up to 10 people.')
    mocks.results.value = [person('late')]
    await nextTick()
    const result = wrapper.get('[data-testid="group-invite-result"]')
    expect(result.attributes('aria-disabled')).toBe('true')
    await result.trigger('click')
    expect(wrapper.find('.selected-user-item').exists()).toBe(false)
  })
})

describe('the viewer by profile id', () => {
  it('is left out of the search and starts the conversation', async () => {
    const wrapper = render({})
    expect([...mocks.excluded!()]).toContain(PROFILE)
    mocks.results.value = [person('partner')]
    await nextTick()
    await wrapper.get('[data-testid="group-invite-result"]').trigger('click')
    await wrapper.get('.footer-button.primary').trigger('click')
    expect(mocks.createOrGetConversation).toHaveBeenCalledWith(PROFILE, 'partner')
  })
})

describe('conversationOthers', () => {
  it('is the partner of a direct conversation and the participants of a group', () => {
    expect(conversationOthers({ type: 'direct', other_user: person('partner') }).map((p) => p.id)).toEqual(['partner'])
    expect(conversationOthers({ type: 'group', participants: people(2) })).toHaveLength(2)
    expect(conversationOthers({ type: 'group' })).toEqual([])
    expect(conversationOthers({ type: 'direct' })).toEqual([])
    expect(conversationOthers(null)).toEqual([])
  })
})
