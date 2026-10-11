/**
 * Invite page: each state (loading, preview, joining, error) is announced, the
 * page has a level-one heading, and the Accept button stays focusable and
 * named while the join runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const { announcer, getInviteInfo, join, push } = vi.hoisted(() => ({
  announcer: { polite: vi.fn(), assertive: vi.fn() },
  getInviteInfo: vi.fn(),
  join: { requestJoin: vi.fn(), confirmJoin: vi.fn(), openServer: vi.fn() },
  push: vi.fn(),
}))

const translate = (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: translate, locale: ref('en') }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { code: 'ABCD1234' } }),
  useRouter: () => ({ push }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'u1' } } }) }))
vi.mock('@/services/inviteService', () => ({ getInviteInfo }))
vi.mock('@/composables/useAnnouncer', () => ({
  useAnnouncer: () => ({ ...announcer, announce: vi.fn() }),
}))

const isJoining = ref(false)
const showRules = ref(false)
vi.mock('@/composables/useInviteJoin', () => ({
  useInviteJoin: () => ({
    isJoining,
    showRules,
    serverRules: ref([]),
    pendingInstanceRules: ref([]),
    needsAgreement: ref(false),
    ...join,
  }),
}))

import InviteAccept from '../InviteAccept.vue'

const INFO = {
  code: 'ABCD1234',
  serverId: 's1',
  serverName: 'Town Hall',
  memberCount: 12,
  description: null,
  icon: null,
  banner: null,
  isMember: false,
  rules: [],
}

let wrapper: VueWrapper

function mountPage() {
  wrapper = mount(InviteAccept, {
    attachTo: document.body,
    global: {
      mocks: { $t: translate, $router: { push } },
      stubs: { LoadingSpinner: true, Icon: true, ServerRulesModal: true },
    },
  })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  announcer.polite.mockClear()
  announcer.assertive.mockClear()
  join.requestJoin.mockClear()
  push.mockClear()
  isJoining.value = false
  showRules.value = false
})

afterEach(() => wrapper.unmount())

describe('InviteAccept states', () => {
  it('announces loading under a level-one heading, then the invite preview', async () => {
    let resolve!: (value: unknown) => void
    getInviteInfo.mockReturnValue(new Promise((r) => { resolve = r }))
    mountPage()

    expect(wrapper.get('[data-testid="invite-accept"]').attributes('data-state')).toBe('loading')
    expect(wrapper.get('.invite-card').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('h1').text()).toBe('a11y.title.invite')
    expect(announcer.polite).toHaveBeenCalledWith('invite.loading')

    resolve({ info: { ...INFO }, error: null })
    await flushPromises()

    expect(wrapper.get('[data-testid="invite-accept"]').attributes('data-state')).toBe('preview')
    expect(wrapper.get('h1').text()).toBe('Town Hall')
    expect(announcer.polite).toHaveBeenLastCalledWith('invite.a11y.preview {"server":"Town Hall"}')
  })

  it('announces joining and keeps the Accept button focusable and busy', async () => {
    getInviteInfo.mockResolvedValue({ info: { ...INFO }, error: null })
    mountPage()
    await flushPromises()

    const accept = wrapper.get('[data-testid="invite-accept-button"]')
    expect(accept.text()).toBe('invite.accept')
    ;(accept.element as HTMLButtonElement).focus()
    await accept.trigger('click')
    expect(join.requestJoin).toHaveBeenCalledTimes(1)

    isJoining.value = true
    await flushPromises()
    expect(announcer.polite).toHaveBeenLastCalledWith('invite.a11y.joining {"server":"Town Hall"}')
    expect(accept.attributes('disabled')).toBeUndefined()
    expect(accept.attributes('aria-disabled')).toBe('true')
    expect(accept.attributes('aria-busy')).toBe('true')
    expect(accept.text()).toBe('invite.joining')
    expect(document.activeElement).toBe(accept.element)

    await wrapper.get('[data-testid="invite-decline-button"]').trigger('click')
    expect(push).not.toHaveBeenCalled()
  })

  it('stays quiet when the rules dialog closes back to the preview', async () => {
    getInviteInfo.mockResolvedValue({ info: { ...INFO, rules: ['Be kind'] }, error: null })
    mountPage()
    await flushPromises()
    announcer.polite.mockClear()

    showRules.value = true
    await flushPromises()
    expect(wrapper.get('[data-testid="invite-accept"]').attributes('data-state')).toBe('rules')
    showRules.value = false
    await flushPromises()
    expect(announcer.polite).not.toHaveBeenCalled()
  })

  it('announces an invalid invite assertively', async () => {
    getInviteInfo.mockResolvedValue({ info: null, error: 'Invite expired' })
    mountPage()
    await flushPromises()

    expect(wrapper.get('[data-testid="invite-accept"]').attributes('data-state')).toBe('error')
    expect(wrapper.get('h1').text()).toBe('invite.invalidTitle')
    expect(announcer.assertive).toHaveBeenCalledWith('invite.invalidTitle. Invite expired')
  })

  it('announces membership when the invite is for a server already joined', async () => {
    getInviteInfo.mockResolvedValue({ info: { ...INFO, isMember: true }, error: null })
    mountPage()
    await flushPromises()
    expect(announcer.polite).toHaveBeenLastCalledWith('invite.a11y.member {"server":"Town Hall"}')
    expect(wrapper.get('[data-testid="invite-open-server"]').text()).toBe('invite.openServer')
  })
})
