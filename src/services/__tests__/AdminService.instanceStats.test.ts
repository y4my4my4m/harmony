/**
 * AdminService.getAdminInstanceStats: one admin_instance_stats call, mapped to InstanceStats; a
 * moderator's object has no queue or database figures; a missing snapshot reads as zeros.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import { adminService, mapInstanceStats } from '@/services/AdminService'
import { applyInstanceChange, applyUserChange } from '@/composables/useInstanceStats'

const from = supabase.from as unknown as ReturnType<typeof vi.fn>
const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const ADMIN_ROW = {
  computed_at: '2026-11-24T07:00:00+00:00',
  compute_ms: 22,
  age_seconds: 130,
  refreshing_elsewhere: false,
  approximate: ['posts_total'],
  users_total: 16004, users_local: 1204, users_federated: 14800, users_suspended: 32, users_new_24h: 44,
  servers_total: 301, servers_active_30d: 31,
  posts_total: 82800, posts_24h: 135,
  instances_total: 2000, instances_blocked: 50, instances_trusted: 80, instances_active_7d: 468, instances_new_24h: 5,
  queue_pending: 500, queue_delivered: 400, queue_failed: 3,
  endpoints_total: 453, endpoints_dead: 22, endpoints_healthy: 370, endpoints_failing: 64,
  endpoints_failures: 25, endpoints_successes: 75,
  db_size_bytes: 117330735, db_connections: 4,
}
const MODERATOR_KEYS = ['queue_pending', 'queue_delivered', 'queue_failed', 'db_size_bytes', 'db_connections']

beforeEach(() => {
  from.mockReset()
  rpc.mockReset()
})

describe('getAdminInstanceStats', () => {
  it('makes one admin_instance_stats call and no table read', async () => {
    rpc.mockResolvedValue({ data: ADMIN_ROW, error: null })
    const stats = await adminService.getAdminInstanceStats()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('admin_instance_stats', { p_refresh: false })
    expect(from).not.toHaveBeenCalled()
    expect(stats.responseMs).toBeGreaterThanOrEqual(0)
  })

  it('passes p_refresh for a refresh', async () => {
    rpc.mockResolvedValue({ data: ADMIN_ROW, error: null })
    await adminService.getAdminInstanceStats(true)
    expect(rpc).toHaveBeenCalledWith('admin_instance_stats', { p_refresh: true })
  })

  it('throws the RPC error', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Permission denied' } })
    await expect(adminService.getAdminInstanceStats()).rejects.toMatchObject({ code: '42501' })
  })
})

describe('mapInstanceStats', () => {
  it('maps an admin snapshot', () => {
    expect(mapInstanceStats(ADMIN_ROW, 12)).toEqual({
      computedAt: '2026-11-24T07:00:00+00:00',
      ageSeconds: 130,
      refreshingElsewhere: false,
      approximate: ['posts_total'],
      users: { total: 16004, local: 1204, federated: 14800, suspended: 32, new24h: 44 },
      servers: { total: 301, active30d: 31 },
      posts: { total: 82800, last24h: 135 },
      instances: { total: 2000, blocked: 50, trusted: 80, active7d: 468, new24h: 5 },
      endpoints: { total: 453, dead: 22, healthy: 370, failing: 64, failures: 25, successes: 75, successRate: 75 },
      queue: { pending: 500, delivered: 400, failed: 3 },
      database: { sizeBytes: 117330735, connections: 4 },
      responseMs: 12,
    })
  })

  it('leaves out the queue and database for a moderator', () => {
    const row = Object.fromEntries(Object.entries(ADMIN_ROW).filter(([k]) => !MODERATOR_KEYS.includes(k)))
    const stats = mapInstanceStats(row, 5)
    expect(stats.queue).toBeNull()
    expect(stats.database).toBeNull()
    expect(stats.instances.total).toBe(2000)
  })

  it('reads a missing snapshot as zeros', () => {
    const row = Object.fromEntries(Object.keys(ADMIN_ROW).map((k) => [k, null]))
    const stats = mapInstanceStats({ ...row, refreshing_elsewhere: true, db_connections: 3 }, 1)
    expect(stats.computedAt).toBeNull()
    expect(stats.ageSeconds).toBeNull()
    expect(stats.refreshingElsewhere).toBe(true)
    expect(stats.approximate).toEqual([])
    expect(stats.users).toEqual({ total: 0, local: 0, federated: 0, suspended: 0, new24h: 0 })
    expect(stats.endpoints.successRate).toBe(100)
    expect(stats.database).toEqual({ sizeBytes: 0, connections: 3 })
  })
})

describe('applyInstanceChange', () => {
  const NOW = Date.parse('2026-11-24T08:00:00Z')
  const counts = () => ({ total: 10, blocked: 2, trusted: 3, active7d: 5, new24h: 1 })
  const row = {
    is_blocked: false, is_trusted: false,
    last_seen_at: '2026-11-23T08:00:00Z', created_at: '2026-10-01T00:00:00Z',
  }

  it('moves trusted and blocked with the flags', () => {
    const c = counts()
    applyInstanceChange(c, row, { ...row, is_trusted: true }, NOW)
    applyInstanceChange(c, row, { ...row, is_blocked: true }, NOW)
    expect(c).toEqual({ total: 10, blocked: 3, trusted: 4, active7d: 5, new24h: 1 })
  })

  it('takes a deleted row out of every count it was in', () => {
    const c = counts()
    applyInstanceChange(c, { ...row, is_blocked: true }, null, NOW)
    expect(c).toEqual({ total: 9, blocked: 1, trusted: 3, active7d: 4, new24h: 1 })
  })

  it('counts an added row as seen and created now', () => {
    const c = counts()
    const at = new Date(NOW).toISOString()
    applyInstanceChange(c, null, { is_blocked: false, is_trusted: true, last_seen_at: at, created_at: at }, NOW)
    expect(c).toEqual({ total: 11, blocked: 2, trusted: 4, active7d: 6, new24h: 2 })
  })
})

describe('applyUserChange', () => {
  const counts = () => ({ total: 10, local: 4, federated: 6, suspended: 1 })

  it('counts a suspension and an unsuspension', () => {
    const c = counts()
    applyUserChange(c, { is_local: true, is_suspended: false }, { is_local: true, is_suspended: true })
    expect(c).toEqual({ total: 10, local: 4, federated: 6, suspended: 2 })
    applyUserChange(c, { is_local: null, is_suspended: true }, { is_local: null, is_suspended: false })
    expect(c).toEqual({ total: 10, local: 4, federated: 6, suspended: 1 })
  })

  it('leaves the counts alone when the flag does not change', () => {
    const c = counts()
    applyUserChange(c, { is_local: true, is_suspended: true }, { is_local: true, is_suspended: true })
    expect(c).toEqual(counts())
  })

  it('counts a null is_local as federated', () => {
    const c = counts()
    applyUserChange(c, null, { is_local: null, is_suspended: false })
    expect(c).toEqual({ total: 11, local: 4, federated: 7, suspended: 1 })
  })
})
