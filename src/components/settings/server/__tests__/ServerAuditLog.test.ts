/**
 * ServerAuditLog.vue: lists get_server_audit_log pages newest first, pages on created_at,
 * and reloads from the top when a filter changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ServerAuditLog from '../ServerAuditLog.vue'
import type { ServerAuditEntry } from '@/services/ServerAuditLogService'

const { api } = vi.hoisted(() => ({
  api: { getServerAuditLog: vi.fn() },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/components/common/Avatar.vue', () => ({ default: { template: '<span class="avatar-stub" />' } }))
vi.mock('@/services/ServerAuditLogService', () => ({
  AUDIT_PAGE_SIZE: 2,
  getServerAuditLog: api.getServerAuditLog,
}))

const SERVER_ID = 'server-1'

function entry(id: string, createdAt: string, overrides: Partial<ServerAuditEntry> = {}): ServerAuditEntry {
  return {
    id,
    created_at: createdAt,
    action: 'member.kick',
    source: 'user',
    actor_id: 'u-alice',
    actor_username: 'alice',
    actor_display_name: 'Alice',
    actor_avatar_url: null,
    actor_bot_id: null,
    actor_bot_name: null,
    actor_bot_avatar_url: null,
    target_type: 'user',
    target_id: 'u-bob',
    target_name: 'bob',
    target_display_name: 'Bob',
    target_avatar_url: null,
    changes: null,
    details: null,
    reason: null,
    ...overrides,
  }
}

const mountLog = () =>
  mount(ServerAuditLog, {
    props: { serverId: SERVER_ID },
    global: { stubs: { Icon: true, LoadingSpinner: true } },
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ServerAuditLog', () => {
  it('shows each entry with its reason', async () => {
    api.getServerAuditLog.mockResolvedValueOnce([
      entry('e1', '2026-10-10T10:00:00Z', { reason: 'spam' }),
    ])
    const wrapper = mountLog()
    await flushPromises()

    expect(api.getServerAuditLog).toHaveBeenCalledWith(SERVER_ID, {
      before: null, limit: 2, action: null, actorId: null,
    })
    const rows = wrapper.findAll('[data-test="audit-entry"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.audit-reason').text()).toBe('serverAuditLog.reason')
    expect(wrapper.find('[data-test="load-more"]').exists()).toBe(false)
  })

  it('loads older entries before the last one shown', async () => {
    api.getServerAuditLog
      .mockResolvedValueOnce([entry('e1', '2026-10-10T10:00:00Z'), entry('e2', '2026-10-10T09:00:00Z')])
      .mockResolvedValueOnce([entry('e3', '2026-10-10T08:00:00Z')])
    const wrapper = mountLog()
    await flushPromises()

    await wrapper.find('[data-test="load-more"]').trigger('click')
    await flushPromises()

    expect(api.getServerAuditLog).toHaveBeenLastCalledWith(SERVER_ID, {
      before: '2026-10-10T09:00:00Z', limit: 2, action: null, actorId: null,
    })
    expect(wrapper.findAll('[data-test="audit-entry"]')).toHaveLength(3)
    expect(wrapper.find('[data-test="load-more"]').exists()).toBe(false)
  })

  it('reloads from the newest entry when a filter changes', async () => {
    api.getServerAuditLog
      .mockResolvedValueOnce([entry('e1', '2026-10-10T10:00:00Z')])
      .mockResolvedValueOnce([entry('e4', '2026-10-10T07:00:00Z', { action: 'role.create', target_type: 'role' })])
      .mockResolvedValueOnce([])
    const wrapper = mountLog()
    await flushPromises()

    const actorOptions = wrapper.find('[data-test="actor-filter"]').findAll('option')
    expect(actorOptions.map(o => o.attributes('value'))).toEqual(['', 'u-alice'])
    expect(actorOptions[1].text()).toBe('Alice')

    await wrapper.find('[data-test="kind-filter"]').setValue('role')
    await flushPromises()
    expect(api.getServerAuditLog).toHaveBeenLastCalledWith(SERVER_ID, {
      before: null, limit: 2, action: 'role', actorId: null,
    })
    expect(wrapper.findAll('[data-test="audit-entry"]')).toHaveLength(1)

    await wrapper.find('[data-test="actor-filter"]').setValue('u-alice')
    await flushPromises()
    expect(api.getServerAuditLog).toHaveBeenLastCalledWith(SERVER_ID, {
      before: null, limit: 2, action: 'role', actorId: 'u-alice',
    })
    expect(wrapper.findAll('[data-test="audit-entry"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('serverAuditLog.empty.filtered')
  })

  it('reports a refused load', async () => {
    api.getServerAuditLog.mockRejectedValueOnce(new Error('VIEW_AUDIT_LOG required'))
    const wrapper = mountLog()
    await flushPromises()

    expect(wrapper.text()).toContain('serverAuditLog.loadError')
    expect(wrapper.findAll('[data-test="audit-entry"]')).toHaveLength(0)
  })
})
