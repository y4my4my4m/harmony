/**
 * AdminPanel.vue Overview: one admin_instance_stats request fills the stats cards and System
 * health, with no exact count; the figures, the snapshot age and approximate marks show; Refresh
 * asks for a refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(async () => {}) }),
  useRoute: () => ({ query: {} }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'aaaaaaaa-0000-0000-0000-000000000001' } } }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { is_admin: true } }) }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))
vi.mock('@/composables/useReportQueueCounts', async () => {
  const { ref } = await import('vue')
  return {
    badgeCount: (n: number) => String(n),
    refreshInstancePendingReports: vi.fn(async () => {}),
    useReportQueueCounts: () => ({ instancePending: ref(0) }),
  }
})
vi.mock('@/composables/useLayoutState', async () => {
  const { ref } = await import('vue')
  return { useLayoutState: () => ({ isMobile: ref(false), openLeftSidebar: vi.fn() }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/admin/ActivityLog.vue', () => stub('ActivityLog'))

import AdminPanel from '../AdminPanel.vue'

enableAutoUnmount(afterEach)

const from = supabase.from as unknown as ReturnType<typeof vi.fn>
const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const SNAPSHOT = {
  computed_at: '2026-11-24T07:00:00+00:00', compute_ms: 22, age_seconds: 240, refreshing_elsewhere: false,
  approximate: ['posts_total'],
  users_total: 16004, users_local: 1204, users_new_24h: 44,
  servers_total: 301, servers_active_30d: 31,
  posts_total: 2500000, posts_24h: 135,
  instances_total: 2000, instances_blocked: 50, instances_trusted: 80, instances_active_7d: 468, instances_new_24h: 5,
  queue_pending: 7, queue_delivered: 400, queue_failed: 3,
  endpoints_total: 453, endpoints_dead: 22, endpoints_healthy: 370, endpoints_failing: 64,
  endpoints_failures: 25, endpoints_successes: 75,
  db_size_bytes: 117330735, db_connections: 4,
}

/** Records every select's options; the staff check reads one profile row. */
const selects: unknown[] = []
function profileQuery() {
  const query: Record<string, unknown> = {}
  query.select = (_cols: unknown, options?: unknown) => { selects.push(options); return query }
  query.or = () => query
  query.maybeSingle = async () => ({ data: { is_admin: true, is_moderator: false }, error: null })
  return query
}

beforeEach(() => {
  selects.length = 0
  from.mockReset()
  rpc.mockReset()
  from.mockImplementation(() => profileQuery())
  rpc.mockImplementation(async (name: string) =>
    name === 'admin_instance_stats' ? { data: SNAPSHOT, error: null } : { data: null, error: null })
})

describe('AdminPanel Overview', () => {
  it('issues exactly one stats request and no exact count', async () => {
    const w = mount(AdminPanel, { global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    const statsCalls = rpc.mock.calls.filter(([name]) => name === 'admin_instance_stats')
    expect(statsCalls).toEqual([['admin_instance_stats', { p_refresh: false }]])
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['admin_instance_stats'])
    expect(from.mock.calls.map(([table]) => table)).toEqual(['profiles'])
    expect(selects.some((o) => (o as { count?: string } | undefined)?.count)).toBe(false)
    expect(w.find('[data-testid="admin-stat-users"]').text()).toBe('16.0K')
    w.unmount()
  })

  it('shows the figures, the snapshot age and approximate marks', async () => {
    const w = mount(AdminPanel, { global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    const text = w.text()
    expect(w.find('[data-testid="admin-stats-updated"]').text()).toBe('Updated 4 min ago')
    expect(text).toContain('+44 in the last 24 hours')
    expect(text).toContain('31 active in the last 30 days')
    expect(text).toContain('+135 in the last 24 hours')
    expect(w.find('[data-testid="admin-stat-posts"]').text()).toBe('≈approximately 2.5M')
    expect(w.find('[data-testid="admin-stat-servers"] .approx-mark').exists()).toBe(false)
    expect(w.find('[data-testid="admin-db-size"]').text()).toBe('112 MB')
    expect(text).toContain('4 connections')
  })

  it('Refresh asks for a refresh', async () => {
    const w = mount(AdminPanel, { global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    await w.find('.refresh-btn').trigger('click')
    await flushPromises()
    expect(rpc.mock.calls.filter(([name]) => name === 'admin_instance_stats'))
      .toEqual([['admin_instance_stats', { p_refresh: false }], ['admin_instance_stats', { p_refresh: true }]])
  })
})
