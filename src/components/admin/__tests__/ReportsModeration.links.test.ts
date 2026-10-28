// A link in a report's detail panel opens through the outside-link path: the panel's clicks stop
// before the document, so it hands its links over itself. Ask-every-link holds them for the
// dialog; the native app opens them in the system browser; the row stays expanded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const runtime = vi.hoisted(() => ({ tauri: false }))
const settings = vi.hoisted(() => ({ trustedHosts: new Set<string>(), askEveryLink: false, trust: vi.fn() }))
const openUrl = vi.hoisted(() => vi.fn(async (_url: string) => {}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: async () => 'me' } }))
vi.mock('@/services/userDataService', () => ({ userDataService: { ensureUsersLoaded: vi.fn(async () => {}) } }))
vi.mock('@/services/AdminService', () => ({ adminService: {} }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }) }))
vi.mock('@/services/instanceConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/instanceConfig')>()),
  isTauriRuntime: () => runtime.tauri,
}))
vi.mock('@/stores/outsideLinkSettings', () => ({ useOutsideLinkSettingsStore: () => settings }))
vi.mock('@/utils/internalLinks', () => ({ isInstanceHost: (host: string) => host === 'har.mony.lol' }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

const report = {
  id: 'r1', report_type: 'message', category: 'spam', reason: 'spam', status: 'pending', source: 'local',
  reporter_id: 'u1', reporter_username: 'ann', reported_user_id: 'u2', reported_user_username: 'troll',
  reported_user_is_local: true, reported_message_id: 'm1',
  reported_message_preview: 'buy now https://spam.example/deal today',
  created_at: '2026-10-22T00:00:00Z', open_reports_on_target: 1, content_snapshot: null,
}
vi.mock('@/services/ReportService', () => ({
  reportService: {
    getReports: vi.fn(async () => ({ reports: [report], total: 1 })),
    getPendingReportsCount: vi.fn(async () => 1),
  },
}))

import { useOutsideLinkPrompt } from '@/services/outsideLinks'
import ReportsModeration from '../ReportsModeration.vue'

enableAutoUnmount(afterEach)

const prompt = useOutsideLinkPrompt()

async function expanded() {
  const w = mount(ReportsModeration, {
    attachTo: document.body,
    global: { stubs: { Icon: true, EmptyState: true, Avatar: true, DisplayName: true }, mocks: { $t: (k: string) => k } },
  })
  await flushPromises()
  await w.get('.report-item').trigger('click')
  return w
}

function clickLink(link: Element): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  link.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  runtime.tauri = false
  settings.askEveryLink = false
  openUrl.mockClear()
  prompt.cancel()
})

describe('ReportsModeration detail links', () => {
  it('renders the preview link without an inline handler', async () => {
    const w = await expanded()
    const link = w.get('.report-detail a.report-link')
    expect(link.attributes('href')).toBe('https://spam.example/deal')
    expect(link.attributes('onclick')).toBeUndefined()
  })

  it('holds a preview link for the dialog with ask-every-link on, the row kept open', async () => {
    settings.askEveryLink = true
    const w = await expanded()
    const prevented = clickLink(w.get('.report-detail a.report-link').element)
    await flushPromises()
    expect(prevented).toBe(true)
    expect(prompt.pending.value?.url).toBe('https://spam.example/deal')
    expect(w.find('.report-detail').exists()).toBe(true)
  })

  it('opens a preview link in the system browser from the native app', async () => {
    runtime.tauri = true
    const w = await expanded()
    expect(clickLink(w.get('.report-detail a.report-link').element)).toBe(true)
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://spam.example/deal'))
    expect(w.find('.report-detail').exists()).toBe(true)
  })
})
