// A report also sent to the moderators of a server hosted elsewhere: their outcome shows once,
// beside the report's own status, which stays this instance's.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t }) }
})
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: async () => 'me' } }))
vi.mock('@/services/userDataService', () => ({ userDataService: { ensureUsersLoaded: vi.fn(async () => {}) } }))
vi.mock('@/services/AdminService', () => ({ adminService: {} }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }) }))

const report = {
  id: 'r1', report_type: 'message', category: 'spam', reason: 'spam', status: 'pending', source: 'local',
  reporter_id: 'u1', reporter_username: 'ann', reported_user_id: 'u2', reported_user_username: 'troll',
  reported_user_is_local: false, reported_user_domain: 'host.test', reported_message_id: 'm1',
  created_at: '2026-10-22T00:00:00Z', open_reports_on_target: 1, content_snapshot: null,
  server_forward: {
    server_id: 's1', server_name: 'Elsewhere', host: 'host.test', status: 'completed',
    forwarded_at: '2026-10-22T00:01:00Z', resolution: 'dismissed', resolved_at: '2026-10-22T01:00:00Z',
  },
}
vi.mock('@/services/ReportService', () => ({
  reportService: {
    getReports: vi.fn(async () => ({ reports: [report], total: 1 })),
    getPendingReportsCount: vi.fn(async () => 1),
  },
}))

import ReportsModeration from '../ReportsModeration.vue'

enableAutoUnmount(afterEach)

describe('ReportsModeration with a server\'s outcome', () => {
  it('shows the outcome once, beside the local status, collapsed and expanded', async () => {
    const w = mount(ReportsModeration, {
      global: { stubs: { Icon: true, EmptyState: true, Avatar: true, DisplayName: true }, mocks: { $t: (k: string) => k } },
    })
    await flushPromises()

    const outcome = () => w.findAll('[data-testid="report-server-resolution"]')
    expect(outcome()).toHaveLength(1)
    expect(outcome()[0].text()).toBe('Elsewhere\'s moderators: Dismissed')
    expect(w.get('.report-status-group .report-status-badge').text()).toBe('pending')

    await w.get('.report-item').trigger('click')
    expect(w.find('.report-detail').exists()).toBe(true)
    expect(outcome()).toHaveLength(1)
    expect(w.get('[data-testid="report-server-forward"]').text()).toBe('Also sent to Elsewhere\'s moderators on host.test')
    expect(w.text()).not.toContain('Resolved by')
  })
})
