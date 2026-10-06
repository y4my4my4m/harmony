/**
 * Settings > Sessions signs other devices out through the database
 * (sign_out_my_sessions, revoke_my_session), never through GoTrue's /logout,
 * whose global and others scopes the API host refuses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { supabase } from '@/supabase'
import SessionsPanel from '../SessionsPanel.vue'

const { toast, confirmMock } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  confirmMock: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

vi.mock('vue-toastification', () => ({
  useToast: () => toast,
}))

vi.mock('@/composables/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock }),
}))

vi.mock('@/composables/usePushNotifications', () => ({
  usePushNotifications: () => ({
    subscriptions: ref([]),
    fetchSubscriptions: vi.fn().mockResolvedValue(undefined),
    removeSubscription: vi.fn(),
  }),
}))

vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'IconStub', render: () => h('span') }) }
})

const SESSIONS = [
  { id: 's-current', created_at: '2026-10-01T00:00:00Z', last_active_at: null, user_agent: null,
    ip: null, aal: 'aal2', is_current: true, push_transports: [] },
  { id: 's-phone', created_at: '2026-10-02T00:00:00Z', last_active_at: null, user_agent: null,
    ip: '198.51.100.4', aal: 'aal2', is_current: false, push_transports: [] },
  { id: 's-laptop', created_at: '2026-10-03T00:00:00Z', last_active_at: null, user_agent: null,
    ip: null, aal: 'aal2', is_current: false, push_transports: [] },
]

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>
const signOut = supabase.auth.signOut as unknown as ReturnType<typeof vi.fn>

function rpcResult(fn: string): { data: unknown; error: unknown } {
  if (fn === 'list_my_sessions') return { data: SESSIONS, error: null }
  if (fn === 'sign_out_my_sessions') return { data: 2, error: null }
  if (fn === 'revoke_my_session') return { data: true, error: null }
  return { data: null, error: null }
}

async function mountPanel() {
  const wrapper = mount(SessionsPanel, {
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  rpc.mockImplementation(async (fn: string) => rpcResult(fn))
  ;(supabase.auth as any).mfa = {
    listFactors: vi.fn().mockResolvedValue({ data: { totp: [{ id: 'f', status: 'verified' }] }, error: null }),
  }
  confirmMock.mockResolvedValue(true)
})

describe('SessionsPanel', () => {
  it('signs out all other devices through sign_out_my_sessions', async () => {
    const wrapper = await mountPanel()
    await wrapper.get('.sec-btn-danger').trigger('click')
    await flushPromises()

    expect(rpc).toHaveBeenCalledWith('sign_out_my_sessions', { p_scope: 'others' })
    expect(signOut).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('security.sessions.revokedOthers')
  })

  it('signs out one device through revoke_my_session', async () => {
    const wrapper = await mountPanel()
    const buttons = wrapper.findAll('.sec-list-item .sec-btn-secondary')
    expect(buttons).toHaveLength(2)
    await buttons[0].trigger('click')
    await flushPromises()

    expect(rpc).toHaveBeenCalledWith('revoke_my_session', { p_session_id: 's-phone' })
    expect(rpc).not.toHaveBeenCalledWith('sign_out_my_sessions', expect.anything())
    expect(signOut).not.toHaveBeenCalled()
  })

  it('does nothing when the confirmation is dismissed', async () => {
    confirmMock.mockResolvedValue(false)
    const wrapper = await mountPanel()
    await wrapper.get('.sec-btn-danger').trigger('click')
    await flushPromises()

    expect(rpc).not.toHaveBeenCalledWith('sign_out_my_sessions', expect.anything())
  })

  it('reports an aal1 refusal from the database', async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === 'sign_out_my_sessions'
        ? { data: null, error: { code: 'PT403', message: 'insufficient_aal' } }
        : rpcResult(fn))
    const wrapper = await mountPanel()
    await wrapper.get('.sec-btn-danger').trigger('click')
    await flushPromises()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
  })
})
