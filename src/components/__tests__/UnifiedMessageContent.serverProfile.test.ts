/**
 * A mention chip shows the mentioned member's nickname in a server message, and the account
 * name in a DM (no server id).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const U = '11111111-1111-4111-8111-111111111111'
const S = 'server-S'

async function render(serverId: string | null) {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: {
      content: [{ type: 'mention', userId: U, username: 'ally_acct', domain: null }],
      messageId: 'm1',
      editableContent: '',
      serverId,
    },
    global: { mocks: { $t: (key: string) => key }, stubs: { DisplayName: false } },
  })
  await flushPromises()
  return wrapper
}

describe('UnifiedMessageContent mention chip', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    const { userDataService } = await import('@/services/userDataService')
    ;(userDataService as any).users.clear()
    ;(userDataService as any).users.set(U, {
      id: U, username: 'ally_acct', displayName: 'Account Name', avatarUrl: 'account.png',
      status: 0, isOnline: false, isMobile: false, createdAt: '', lastSeen: '', lastHeartbeat: '',
      isLocal: true, lastCacheUpdate: '', source: 'database',
    })
    userDataService.setMemberServerProfile(S, U, { nickname: 'Ally' })
  })

  it('shows the nickname in a server message', async () => {
    const w = await render(S)
    expect(w.get('.mention').text()).toContain('@Ally')
  })

  it('shows the account name in a DM', async () => {
    const w = await render(null)
    expect(w.get('.mention').text()).toContain('@Account Name')
  })
})
