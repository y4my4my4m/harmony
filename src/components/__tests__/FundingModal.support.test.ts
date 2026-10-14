/**
 * The funding dialog speaks of support, not donations: its title and links heading say
 * Support, and a Stripe Payment Link without an admin label reads "One-time".
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import en from '@/locales/en.json'
import { supabase } from '@/supabase'

vi.mock('@/services/instanceConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/instanceConfig')>()),
  getInstanceDomain: () => 'harmony.test',
}))
vi.mock('@/services/FundingService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/FundingService')>()),
  fundingService: {
    getFundingWithProgress: vi.fn(async () => ({
      enabled: true,
      goal_amount: null,
      funding_links: [
        { platform: 'stripe', url: 'https://buy.stripe.com/test_abc', label: '' },
        { platform: 'kofi', url: 'https://ko-fi.com/harmony', label: '' },
      ],
    })),
    getTiers: vi.fn(async () => []),
    getActiveSupporterCount: vi.fn(async () => 0),
    getSupporterBadge: vi.fn(async () => null),
    getDonationHistory: vi.fn(async () => []),
  },
}))

import FundingModal from '@/components/FundingModal.vue'

describe('FundingModal', () => {
  it('names the dialog and its links Support; an unlabelled Stripe link is One-time', async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({ data: { user: null }, error: null } as never)
    const wrapper = mount(FundingModal, {
      attachTo: document.body,
      global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } }), createPinia()] },
    })
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('#funding-modal-title')?.textContent).toBe('Support this instance')
    expect(dialog.querySelector('.funding-links h3')?.textContent).toBe('Support')
    const titles = [...dialog.querySelectorAll('.link-platform')].map((el) => el.textContent)
    expect(titles[0]).toBe('One-time')
    expect(dialog.textContent).not.toMatch(/donat/i)
    wrapper.unmount()
  })
})
