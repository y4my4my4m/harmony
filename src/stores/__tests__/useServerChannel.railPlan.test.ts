/**
 * applyRailPlan and setServerMuted: local state changes before the writes
 * resolve, and a failed write restores it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const toastError = vi.fn()
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }) }))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: { connect: vi.fn(), on: vi.fn().mockReturnValue(() => {}), send: vi.fn(), disconnect: vi.fn() },
}))

import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { Server, ServerFolder } from '@/types'

type Result = { error: { message: string } | null }

/** Chainable PostgREST stub; every terminal await resolves to `result(table, op)`. */
function stubFrom(result: (table: string, op: string) => Result) {
  const calls: { table: string; op: string; payload?: unknown }[] = []
  ;(supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const make = (op: string, payload?: unknown) => {
      calls.push({ table, op, payload })
      const chain: any = {
        eq: () => chain,
        in: () => chain,
        then: (ok: (r: Result) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(result(table, op)).then(ok, bad),
      }
      return chain
    }
    return {
      insert: (p: unknown) => make('insert', p),
      update: (p: unknown) => make('update', p),
      delete: () => make('delete'),
    }
  })
  return calls
}

const s = (id: string, position: number, folder_id: string | null = null) =>
  ({ id, name: id, position, folder_id }) as unknown as Server

describe('applyRailPlan', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    toastError.mockReset()
  })

  const seed = () => {
    const store = useServerChannelStore()
    store.currentUserId = 'me'
    store.servers = [s('a', 0), s('b', 1), s('c', 0, 'F1')]
    store.folders = [{ id: 'F1', user_id: 'me', name: 'F', color: '#000', position: 2, is_expanded: false } as ServerFolder]
    return store
  }

  it('applies locally before the writes settle, in create, move, delete order', async () => {
    const store = seed()
    const calls = stubFrom(() => ({ error: null }))
    const pending = store.applyRailPlan({
      createFolder: { id: 'NEW', position: 0 },
      serverUpdates: [
        { serverId: 'a', folderId: 'NEW', position: 0 },
        { serverId: 'b', folderId: 'NEW', position: 1 },
        { serverId: 'c', folderId: null, position: 1 },
      ],
      folderUpdates: [],
      deleteFolders: ['F1'],
    })
    expect(store.servers.map(x => [x.id, x.folder_id, x.position])).toEqual([['a', 'NEW', 0], ['b', 'NEW', 1], ['c', null, 1]])
    expect(store.folders.map(f => f.id)).toEqual(['NEW'])
    expect(await pending).toBe(true)
    expect(calls.map(c => `${c.table}:${c.op}`)).toEqual([
      'server_folders:insert',
      'user_servers:update',
      'user_servers:update',
      'user_servers:update',
      'server_folders:delete',
    ])
  })

  it('rolls back every change when a write fails', async () => {
    const store = seed()
    stubFrom((table, op) => (table === 'user_servers' && op === 'update' ? { error: { message: 'denied' } } : { error: null }))
    const ok = await store.applyRailPlan({
      serverUpdates: [{ serverId: 'b', folderId: null, position: 0 }, { serverId: 'a', folderId: null, position: 1 }],
      folderUpdates: [{ folderId: 'F1', position: 5 }],
      deleteFolders: [],
    })
    expect(ok).toBe(false)
    expect(store.servers.map(x => [x.id, x.folder_id, x.position])).toEqual([['a', null, 0], ['b', null, 1], ['c', 'F1', 0]])
    expect(store.folders[0].position).toBe(2)
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})

describe('setServerMuted', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('mutes with an expiry and restores on failure', async () => {
    const store = useServerChannelStore()
    store.currentUserId = 'me'
    store.servers = [s('a', 0)]
    const calls = stubFrom(() => ({ error: null }))
    const until = new Date('2030-01-01T00:00:00Z')
    expect(await store.setServerMuted('a', until)).toBe(true)
    expect(store.servers[0]).toMatchObject({ muted: true, muted_until: until.toISOString() })
    expect(calls[0].payload).toEqual({ muted: true, muted_until: until.toISOString() })

    stubFrom(() => ({ error: { message: 'nope' } }))
    expect(await store.setServerMuted('a', false)).toBe(false)
    expect(store.servers[0]).toMatchObject({ muted: true, muted_until: until.toISOString() })
  })
})
