/**
 * PrivacySettings.vue "Require follow approval": read from profiles.manually_approves_followers
 * on mount, written on toggle, and restored when the write fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ loadBlockingData: vi.fn() }) }))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerToggle: vi.fn() }) }))
vi.mock('@/utils/urlTrackerStripper', () => ({
  isUrlTrackingStrippingEnabled: () => true,
  setUrlTrackingStrippingEnabled: vi.fn(),
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/encryption/EncryptionSettings.vue', () => stub('EncryptionSettings'))
vi.mock('../DataExportPanel.vue', () => stub('DataExportPanel'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))
vi.mock('@/components/icons/Shield.vue', () => stub('ShieldIcon'))

import { supabase } from '@/supabase'
import PrivacySettings from '../PrivacySettings.vue'

let stored: { manually_approves_followers: boolean }
let updates: Array<{ patch: Record<string, unknown>; id: unknown }>
let failUpdate = false

function query(table: string) {
  let patch: Record<string, unknown> | null = null
  const chain: any = {
    select: () => chain,
    in: () => chain,
    update: (p: Record<string, unknown>) => { patch = p; return chain },
    eq: (_col: string, id: unknown) => {
      if (patch) {
        updates.push({ patch, id })
        if (!failUpdate) Object.assign(stored, patch)
        return Promise.resolve({ error: failUpdate ? { message: 'denied' } : null })
      }
      return chain
    },
    maybeSingle: async () => ({ data: table === 'profiles' ? { ...stored } : null, error: null }),
    then: (resolve: any) => resolve({ data: [], error: null }),
  }
  return chain
}

const toggle = (wrapper: ReturnType<typeof mount>) => wrapper.get('[data-testid="follow-approval-toggle"]')

function mountSettings() {
  return mount(PrivacySettings, {
    props: { profile: { id: 'me', username: 'me' } as any, loading: false },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { 'i18n-t': true, 'router-link': true },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stored = { manually_approves_followers: false }
  updates = []
  failUpdate = false
  ;(supabase.from as any).mockImplementation(query)
})

describe('PrivacySettings follow approval', () => {
  it('shows the stored setting', async () => {
    stored.manually_approves_followers = true
    const wrapper = mountSettings()
    await flushPromises()

    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
  })

  it('locks the account on toggle and unlocks it on the next', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')

    await toggle(wrapper).trigger('click')
    await flushPromises()
    expect(updates).toEqual([{ patch: { manually_approves_followers: true }, id: 'me' }])
    expect(stored.manually_approves_followers).toBe(true)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')

    await toggle(wrapper).trigger('click')
    await flushPromises()
    expect(updates[1]).toEqual({ patch: { manually_approves_followers: false }, id: 'me' })
    expect(stored.manually_approves_followers).toBe(false)
  })

  it('restores the switch when the write fails', async () => {
    failUpdate = true
    const wrapper = mountSettings()
    await flushPromises()

    await toggle(wrapper).trigger('click')
    await flushPromises()

    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')
    expect(toast.error).toHaveBeenCalledWith('activitypub.followApprovalFailed')
  })
})
