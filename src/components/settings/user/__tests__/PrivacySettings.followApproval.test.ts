/**
 * PrivacySettings.vue "Require follow approval": read from profiles.manually_approves_followers
 * on mount, written on toggle and confirmed, and restored when the write fails. Every
 * switch applies on change; the section has no Save or Reset.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const setStrip = vi.hoisted(() => vi.fn())
const outsideLinks = vi.hoisted(() => ({
  askEveryLink: false,
  signedIn: true,
  hostList: [] as string[],
  reload: vi.fn(async () => {}),
  setAskEveryLink: vi.fn(async (_on: boolean) => {}),
  untrust: vi.fn(async (_host: string) => {}),
}))
const photoDetails = vi.hoisted(() => ({
  keepByDefault: false,
  signedIn: true,
  reload: vi.fn(async () => {}),
  setKeepByDefault: vi.fn(async (_on: boolean) => {}),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ loadBlockingData: vi.fn() }) }))
vi.mock('@/stores/outsideLinkSettings', async () => {
  const { reactive } = await import('vue')
  const store = reactive(outsideLinks)
  return { useOutsideLinkSettingsStore: () => store }
})
vi.mock('@/stores/photoDetailsSettings', async () => {
  const { reactive } = await import('vue')
  const store = reactive(photoDetails)
  return { usePhotoDetailsSettingsStore: () => store }
})
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerToggle: vi.fn() }) }))
vi.mock('@/utils/urlTrackerStripper', () => ({
  isUrlTrackingStrippingEnabled: () => true,
  setUrlTrackingStrippingEnabled: setStrip,
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
  outsideLinks.askEveryLink = false
  photoDetails.keepByDefault = false
  outsideLinks.hostList = []
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
    expect(toast.success).toHaveBeenCalledWith('settings.toasts.privacyUpdated')

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
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('PrivacySettings save model', () => {
  it('has no Save or Reset button', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    const labels = wrapper.findAll('button').map((b) => b.text().trim())
    expect(labels).not.toContain('Save changes')
    expect(labels).not.toContain('Reset')
  })

  it('stores the tracking-parameter switch on change and confirms it', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    await wrapper.get('[data-testid="strip-url-trackers-toggle"]').trigger('click')
    await flushPromises()
    expect(setStrip).toHaveBeenCalledWith(false)
    expect(toast.success).toHaveBeenCalledWith('settings.toasts.privacyUpdated')
  })
})

describe('PrivacySettings outside links', () => {
  it('saves ask-every-link on change and confirms it', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(outsideLinks.reload).toHaveBeenCalled()
    await wrapper.get('[data-testid="ask-every-link-toggle"]').trigger('click')
    await flushPromises()
    expect(outsideLinks.setAskEveryLink).toHaveBeenCalledWith(true)
    expect(toast.success).toHaveBeenCalledWith('settings.toasts.privacyUpdated')
  })

  it('says when the setting could not be saved', async () => {
    outsideLinks.setAskEveryLink.mockRejectedValueOnce(new Error('denied'))
    const wrapper = mountSettings()
    await flushPromises()
    await wrapper.get('[data-testid="ask-every-link-toggle"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('outsideLink.settings.saveFailed')
  })

  it('lists trusted sites, each with a named Remove', async () => {
    outsideLinks.hostList = ['example.com', 'docs.example.org']
    const wrapper = mountSettings()
    await flushPromises()
    const items = wrapper.findAll('[data-testid="trusted-sites"] li')
    expect(items.map((li) => li.find('.trusted-host').text())).toEqual(['example.com', 'docs.example.org'])
    const remove = items[1].get('button')
    expect(remove.attributes('aria-label')).toBe('outsideLink.settings.removeLabel')
    await remove.trigger('click')
    expect(outsideLinks.untrust).toHaveBeenCalledWith('docs.example.org')
  })

  it('says when no site is trusted', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.find('[data-testid="trusted-sites-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trusted-sites"]').exists()).toBe(false)
  })
})

describe('PrivacySettings photo details', () => {
  it('saves keep-photo-details-by-default on change and confirms it', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(photoDetails.reload).toHaveBeenCalled()
    const toggle = wrapper.get('[data-testid="keep-photo-details-default-toggle"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
    expect(photoDetails.setKeepByDefault).toHaveBeenCalledWith(true)
    expect(toast.success).toHaveBeenCalledWith('settings.toasts.privacyUpdated')
  })

  it('says when the setting could not be saved', async () => {
    photoDetails.setKeepByDefault.mockRejectedValueOnce(new Error('denied'))
    const wrapper = mountSettings()
    await flushPromises()
    await wrapper.get('[data-testid="keep-photo-details-default-toggle"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('photoDetails.settings.saveFailed')
  })
})
