/**
 * The Support window: two tabs on an instance that is not the Harmony project's, one view on
 * the project's own instance. It speaks of support, not donations; an unlabelled Stripe
 * Payment Link reads "One-time" and carries the donor's profile id, the project's links do not.
 * Supporter messages and names are text: markup in them stays text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import en from '@/locales/en.json'

vi.mock('@/services/instanceConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/instanceConfig')>()),
  getInstanceDomain: () => 'harmony.test',
}))

const service = vi.hoisted(() => ({
  getFundingSummary: vi.fn(),
  getProjectFunding: vi.fn(),
  setSupporterMessage: vi.fn(),
  deleteSupporterMessage: vi.fn(),
  adminReviewSupporterMessage: vi.fn(),
}))
vi.mock('@/services/FundingService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/FundingService')>()),
  fundingService: service,
}))

import FundingModal from '@/components/FundingModal.vue'
import { useFundingStore } from '@/stores/useFunding'

const XSS = '<img src=x onerror="window.__xss=1">'

const SUMMARY = {
  id: 'f1',
  enabled: true,
  goal_amount: 100,
  goal_currency: 'USD',
  current_amount: 0,
  funding_period: 'monthly',
  goal_description: 'Server costs',
  funding_links: [
    { platform: 'stripe', url: 'https://buy.stripe.com/test_abc', label: '' },
    { platform: 'ko-fi', url: 'https://ko-fi.com/harmony', label: '' },
  ],
  show_progress_bar: true,
  show_in_context_bar: true,
  context_bar_style: 'mini-progress',
  thank_you_message: null,
  kofi_auto_assign_tier: true,
  stripe_auto_assign_tier: true,
  supporter_messages_enabled: true,
  supporter_messages_public: true,
  displayed_amount: 25,
  period_start: '2026-11-01T00:00:00+00:00',
  period_end: '2026-12-01T00:00:00+00:00',
  supporter_count: 3,
  tiers: [],
  messages: [
    { id: 'm1', body: XSS, anonymous: false, at: '2026-11-04T10:00:00Z', user_id: 'u1', name: '<b>Mallory</b>', avatar_url: null },
    { id: 'm2', body: 'Thanks!', anonymous: true, at: '2026-11-03T10:00:00Z', user_id: null, name: null, avatar_url: null },
  ],
  me: { profile_id: 'p-me', badge: null, donations: [], messages: [] },
}

const PROJECT = {
  projectInstance: false,
  source: 'upstream',
  fetchedAt: '2026-11-05T00:00:00Z',
  funding: {
    version: 1,
    instance: 'har.mony.lol',
    enabled: true,
    goal: null,
    supporters: 8,
    links: [{ platform: 'stripe', url: 'https://buy.stripe.com/project', label: 'One-time' }],
    messages: [],
  },
}

let wrapper: VueWrapper | null = null

async function open() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useFundingStore().openModal('instance')
  wrapper = mount(FundingModal, {
    attachTo: document.body,
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } }), pinia] },
  })
  await flushPromises()
  return document.body.querySelector('[role="dialog"]') as HTMLElement
}

beforeEach(() => {
  service.getFundingSummary.mockResolvedValue(structuredClone(SUMMARY))
  service.getProjectFunding.mockResolvedValue(structuredClone(PROJECT))
  localStorage.clear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('FundingModal', () => {
  it('shows two tabs on a self-hosted instance; links say Support and One-time', async () => {
    const dialog = await open()
    expect(dialog.querySelector('.modal-title')?.textContent).toBe('Support')
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((el) => el.textContent?.trim())
    expect(tabs).toEqual(['This instance', 'Harmony development'])
    expect(dialog.querySelector('[data-testid="support-reset"]')?.textContent?.trim()).toBe('Resets Dec 1 (UTC)')
    const instanceLinks = [...dialog.querySelectorAll<HTMLAnchorElement>('[data-testid="support-links-instance"] a')]
    expect(instanceLinks[0].querySelector('.support-link__title')?.textContent).toBe('One-time')
    expect(new URL(instanceLinks[0].href).searchParams.get('client_reference_id')).toBe('p-me')
    expect(dialog.textContent).not.toMatch(/donat/i)
  })

  it('opens the project tab with the project links, which carry no profile id', async () => {
    const dialog = await open()
    ;(dialog.querySelector('[data-testid="support-tab-project"]') as HTMLElement).click()
    await flushPromises()
    const panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
    expect(panel.style.display).not.toBe('none')
    const link = panel.querySelector<HTMLAnchorElement>('[data-testid="support-links-project"] a')!
    expect(link.href).toBe('https://buy.stripe.com/project')
  })

  it('shows the project\'s messages beside its links, and drops the column when there are none', async () => {
    const withMessages = structuredClone(PROJECT)
    withMessages.funding.messages = [
      { id: 'p1', body: 'Thanks for Harmony', name: 'Ada', at: '2026-11-04T10:00:00Z' },
    ] as never[]
    service.getProjectFunding.mockResolvedValue(withMessages)
    let dialog = await open()
    let panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
    expect(panel.querySelector('[data-testid="supporter-wall-project"]')?.textContent).toContain('Thanks for Harmony')
    expect(panel.querySelectorAll('.support-grid > .support-col')).toHaveLength(2)
    expect(panel.querySelector('.support-grid')?.classList.contains('support-grid--single')).toBe(false)
    wrapper?.unmount()
    document.body.innerHTML = ''

    service.getProjectFunding.mockResolvedValue(structuredClone(PROJECT))
    dialog = await open()
    panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
    expect(panel.querySelector('[data-testid="support-links-project"]')).not.toBeNull()
    expect(panel.querySelector('[data-testid="supporter-wall-project"]')).toBeNull()
    expect(panel.querySelectorAll('.support-grid > .support-col')).toHaveLength(1)
    expect(panel.querySelector('.support-grid')?.classList.contains('support-grid--single')).toBe(true)
    expect(panel.textContent).not.toContain('No messages')
  })

  it('shows one view on the project instance', async () => {
    service.getProjectFunding.mockResolvedValue({ projectInstance: true })
    const dialog = await open()
    expect(dialog.querySelector('[role="tablist"]')).toBeNull()
    expect(dialog.querySelector('.modal-title')?.textContent).toBe('Support Harmony')
    expect(dialog.querySelector('[data-testid="support-project-instance"]')?.textContent).toContain('harmony.test is run by the Harmony project')
  })

  it('renders supporter messages and names as text', async () => {
    const dialog = await open()
    const bodies = [...dialog.querySelectorAll('[data-testid="supporter-message-body"]')]
    expect(bodies[0].textContent).toBe(XSS)
    expect(bodies[0].querySelector('img')).toBeNull()
    expect(dialog.querySelector('[data-testid="supporter-wall-instance"] img, [data-testid="supporter-wall-instance"] b')).toBeNull()
    const names = [...dialog.querySelectorAll('[data-testid="supporter-message-name"]')].map((el) => el.textContent)
    expect(names).toEqual(['<b>Mallory</b>', 'Anonymous'])
    expect((window as any).__xss).toBeUndefined()
  })
})
