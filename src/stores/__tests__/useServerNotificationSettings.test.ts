/**
 * Notification settings store: one fetch per server, writes applied before they land and
 * restored when they fail, the server mute mirrored onto the rail, and refetch on
 * notification_settings:changed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const toastError = vi.fn()
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError, success: vi.fn() }) }))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
const handlers = vi.hoisted(() => new Map<string, (payload: Record<string, unknown>) => void>())
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    connect: vi.fn(),
    on: vi.fn((type: string, handler: (payload: Record<string, unknown>) => void) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    }),
    send: vi.fn(),
    disconnect: vi.fn(),
  },
}))

import { supabase } from '@/supabase'
import { useServerNotificationSettingsStore } from '@/stores/useServerNotificationSettings'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { Server } from '@/types'

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const state = (overrides: Record<string, unknown> = {}) => ({
  server_id: 's1',
  muted: false,
  muted_until: null,
  level: null,
  server_default: 'mentions',
  suppress_everyone: false,
  suppress_roles: false,
  push_notifications: true,
  overrides: [],
  channels: [{ id: 'c1', name: 'general', type: 0, category_id: 'k1', position: 0 }],
  categories: [{ id: 'k1', name: 'Text', position: 0 }],
  ...overrides,
})

beforeEach(() => {
  setActivePinia(createPinia())
  rpc.mockReset()
  toastError.mockReset()
})

describe('useServerNotificationSettingsStore', () => {
  it('loads a server once while a fetch is in flight', async () => {
    rpc.mockResolvedValue({ data: state(), error: null })
    const store = useServerNotificationSettingsStore()
    await Promise.all([store.load('s1'), store.load('s1')])
    await store.load('s1')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_server_notification_settings', { p_server_id: 's1' })
    expect(store.channelLevel('s1', 'c1', 'k1')).toBe('mentions')
  })

  it('mirrors the server mute onto the rail', async () => {
    const servers = useServerChannelStore()
    servers.servers = [{ id: 's1', name: 'One' } as Server]
    rpc.mockResolvedValue({ data: state({ muted: true, muted_until: '2030-01-01T00:00:00Z' }), error: null })
    await useServerNotificationSettingsStore().setServerMute('s1', '2030-01-01T00:00:00Z')
    expect(rpc).toHaveBeenCalledWith('update_server_notification_settings', {
      p_server_id: 's1',
      p_changes: { muted: true, muted_until: '2030-01-01T00:00:00Z' },
    })
    expect(servers.servers[0]).toMatchObject({ muted: true, muted_until: '2030-01-01T00:00:00Z' })
  })

  it('shows a write before it lands and restores the state when it fails', async () => {
    rpc.mockResolvedValueOnce({ data: state(), error: null })
    const store = useServerNotificationSettingsStore()
    await store.load('s1')

    let fail!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise((resolve) => { fail = resolve }))
    const write = store.updateServer('s1', { level: 'all' })
    expect(store.settingsFor('s1')?.level).toBe('all')
    expect(store.channelLevel('s1', 'c1', 'k1')).toBe('all')

    fail({ data: null, error: { message: 'nope' } })
    expect(await write).toBe(false)
    expect(store.settingsFor('s1')?.level).toBeNull()
    expect(toastError).toHaveBeenCalledWith("Couldn't save notification settings")
  })

  it('writes channel and category overrides and marks muted channels', async () => {
    rpc.mockResolvedValueOnce({ data: state(), error: null })
    const store = useServerNotificationSettingsStore()
    await store.load('s1')

    const muted = state({
      overrides: [{ channel_id: null, category_id: 'k1', level: 'none', muted: true, muted_until: null }],
    })
    rpc.mockResolvedValueOnce({ data: muted, error: null })
    await store.updateOverride('s1', { categoryId: 'k1' }, { muted: true })
    expect(rpc).toHaveBeenLastCalledWith('update_category_notification_override', {
      p_category_id: 'k1',
      p_changes: { muted: true },
    })
    expect(store.isChannelMuted('s1', 'c1', 'k1')).toBe(true)
    expect(store.isChannelMuted('s1', 'c1', null)).toBe(false)
    expect(store.channelLevel('s1', 'c1', 'k1')).toBe('none')

    rpc.mockResolvedValueOnce({ data: state(), error: null })
    await store.removeOverride('s1', { channelId: 'c1' })
    expect(rpc).toHaveBeenLastCalledWith('update_channel_notification_override', {
      p_channel_id: 'c1',
      p_changes: { level: null, muted: false },
    })
    expect(store.settingsFor('s1')?.overrides).toEqual([])
  })

  it('runs writes in order and shows the last one\'s state', async () => {
    rpc.mockResolvedValueOnce({ data: state(), error: null })
    const store = useServerNotificationSettingsStore()
    await store.load('s1')

    let finishFirst!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
    rpc.mockResolvedValueOnce({ data: state({ level: 'all', suppress_roles: true }), error: null })
    const first = store.updateServer('s1', { level: 'all' })
    const second = store.updateServer('s1', { suppress_roles: true })
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    expect(store.settingsFor('s1')).toMatchObject({ level: 'all', suppress_roles: true })

    finishFirst({ data: state({ level: 'all' }), error: null })
    await Promise.all([first, second])
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(store.settingsFor('s1')).toMatchObject({ level: 'all', suppress_roles: true })
  })

  it('refetches a loaded server when another device changes it', async () => {
    rpc.mockResolvedValue({ data: state(), error: null })
    const store = useServerNotificationSettingsStore()
    await store.load('s1')
    rpc.mockResolvedValue({ data: state({ level: 'none' }), error: null })

    handlers.get('notification_settings:changed')?.({ server_id: 's1' })
    await vi.waitFor(() => expect(store.settingsFor('s1')?.level).toBe('none'))

    handlers.get('notification_settings:changed')?.({ server_id: 'other' })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('opens the modal with fresh state', async () => {
    rpc.mockResolvedValue({ data: state(), error: null })
    const store = useServerNotificationSettingsStore()
    store.openModal('s1')
    expect(store.modalServerId).toBe('s1')
    await vi.waitFor(() => expect(store.settingsFor('s1')).not.toBeNull())
    store.closeModal()
    expect(store.modalServerId).toBeNull()
  })
})
