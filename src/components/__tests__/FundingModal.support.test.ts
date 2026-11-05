/**
 * The Support window: two tabs on every instance. It speaks of support, not donations; an
 * unlabelled Stripe Payment Link reads "One-time" and carries the donor's profile id; the
 * project's links are PROJECT_LINKS whatever the feed lists, and carry no profile id except on
 * the project's own instance, where its Harmony development tab is its own project fund and
 * takes a message for it. Supporter messages and names are text: markup in them stays text.
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
import { PROJECT_LINKS } from '@/services/FundingService'
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

  it('opens the project tab with the project\'s own links, never the feed\'s, which carry no profile id', async () => {
    const dialog = await open()
    ;(dialog.querySelector('[data-testid="support-tab-project"]') as HTMLElement).click()
    await flushPromises()
    const panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
    expect(panel.style.display).not.toBe('none')
    const links = [...panel.querySelectorAll<HTMLAnchorElement>('[data-testid="support-links-project"] a')]
    expect(links.map((a) => a.href)).toEqual(PROJECT_LINKS.map((l) => l.url))
    expect(panel.innerHTML).not.toContain('buy.stripe.com/project')
  })

  it('shows the project\'s own links when the feed lists none, or is a fallback', async () => {
    for (const source of ['upstream', 'fallback'] as const) {
      const bare = structuredClone(PROJECT)
      bare.source = source
      bare.funding.links = []
      service.getProjectFunding.mockResolvedValue(bare)
      const dialog = await open()
      const panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
      const links = [...panel.querySelectorAll<HTMLAnchorElement>('[data-testid="support-links-project"] a')]
      expect(links.map((a) => a.href)).toEqual(PROJECT_LINKS.map((l) => l.url))
      expect(!!panel.querySelector('[data-testid="support-project-fallback"]')).toBe(source === 'fallback')
      wrapper?.unmount()
      document.body.innerHTML = ''
    }
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

  it('shows both funds on the project instance; its project links credit the donor and take a project message', async () => {
    const own = structuredClone(PROJECT)
    own.projectInstance = true
    own.source = 'local'
    own.funding.instance = 'harmony.test'
    own.funding.supporters = 2
    own.funding.messages = [{ id: 'p1', body: 'For Harmony', name: null, at: '2026-11-04T10:00:00Z' }] as never[]
    service.getProjectFunding.mockResolvedValue(own)
    const summary = structuredClone(SUMMARY) as typeof SUMMARY & { project_messages_enabled: boolean }
    summary.project_messages_enabled = true
    summary.me = {
      ...summary.me,
      project: {
        donations: [],
        messages: [{ id: 'mine', body: 'Waiting for mine', anonymous: false, attached: false, review: 'pending', created_at: '2026-11-05T00:00:00Z', attached_at: null, expires_at: '2026-11-06T00:00:00Z' }],
      },
    } as never
    service.getFundingSummary.mockResolvedValue(summary)
    service.setSupporterMessage.mockResolvedValue({ id: 'mine2', body: 'Go Harmony', anonymous: false, attached: false, review: 'pending', created_at: '2026-11-05T00:00:00Z', attached_at: null, expires_at: '2026-11-06T00:00:00Z' })

    const dialog = await open()
    expect(dialog.querySelector('.modal-title')?.textContent).toBe('Support')
    expect([...dialog.querySelectorAll('[role="tab"]')].map((el) => el.textContent?.trim())).toEqual(['This instance', 'Harmony development'])
    const instance = dialog.querySelector('[data-testid="support-panel-instance"]') as HTMLElement
    expect(instance.querySelectorAll('[data-testid="support-message"]')).toHaveLength(1)
    expect(instance.textContent).not.toContain('Waiting for mine')

    ;(dialog.querySelector('[data-testid="support-tab-project"]') as HTMLElement).click()
    await flushPromises()
    const panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
    const link = panel.querySelector<HTMLAnchorElement>('[data-testid="support-links-project"] a')!
    expect(new URL(link.href).searchParams.get('client_reference_id')).toBe('p-me')
    expect(link.href.startsWith(PROJECT_LINKS[0].url)).toBe(true)
    expect(panel.querySelector('[data-testid="support-project-footnote"]')?.textContent).toContain("kept apart from harmony.test's own server funding")
    const wall = panel.querySelector('[data-testid="supporter-wall-project"]') as HTMLElement
    expect([...wall.querySelectorAll('[data-testid="supporter-message-body"]')].map((el) => el.textContent)).toEqual(['Waiting for mine', 'For Harmony'])

    const input = panel.querySelector<HTMLInputElement>('[data-testid="support-message-input"]')!
    input.value = 'Go Harmony'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    ;(panel.querySelector('[data-testid="support-message-save"]') as HTMLElement).click()
    await flushPromises()
    expect(service.setSupporterMessage).toHaveBeenCalledWith('Go Harmony', false, 'project')
  })

  it('shows no project composer off the project instance', async () => {
    const summary = structuredClone(SUMMARY) as typeof SUMMARY & { project_messages_enabled: boolean }
    summary.project_messages_enabled = true
    service.getFundingSummary.mockResolvedValue(summary)
    const dialog = await open()
    const panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
    expect(panel.querySelector('[data-testid="support-message"]')).toBeNull()
    expect(panel.querySelector('[data-testid="support-project-footnote"]')?.textContent).toContain("You pay on har.mony.lol's own pages")
  })

  it('names har.mony.lol as where payment happens, whatever instance the feed names', async () => {
    const other = structuredClone(PROJECT)
    other.funding.instance = 'pocket.example'
    service.getProjectFunding.mockResolvedValue(other)
    const dialog = await open()
    const panel = dialog.querySelector('[data-testid="support-panel-project"]') as HTMLElement
    expect(panel.querySelector('[data-testid="support-project-footnote"]')?.textContent).toContain("You pay on har.mony.lol's own pages")
    expect(panel.textContent).not.toContain('pocket.example')
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
