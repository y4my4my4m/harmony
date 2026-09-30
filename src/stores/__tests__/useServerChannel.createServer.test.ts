import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'

const SERVER = { id: 'srv-1', name: 'New', owner: 'user-1' }

interface TableCalls {
  serverInserts: number
  serverDeletes: string[]
  membershipInserts: number
}

function mockTables(opts: { serverInsertError?: object; membershipError?: object }): TableCalls {
  const calls: TableCalls = { serverInserts: 0, serverDeletes: [], membershipInserts: 0 }

  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    if (table === 'servers') {
      return {
        insert: () => {
          calls.serverInserts++
          return {
            select: () => ({
              single: async () => opts.serverInsertError
                ? { data: null, error: opts.serverInsertError }
                : { data: { ...SERVER }, error: null },
            }),
          }
        },
        delete: () => ({
          eq: async (_col: string, id: string) => {
            calls.serverDeletes.push(id)
            return { error: null }
          },
        }),
      }
    }
    if (table === 'user_servers') {
      return {
        insert: async () => {
          calls.membershipInserts++
          return { error: opts.membershipError ?? null }
        },
      }
    }
    throw new Error(`unexpected table ${table}`)
  }) as any)

  return calls
}

describe('useServerChannelStore.createServer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.from).mockReset()
  })

  it('inserts once and keeps the server on success', async () => {
    const calls = mockTables({})
    const store = useServerChannelStore()

    const created = await store.createServer({ name: 'New', owner: 'user-1' })

    expect(created.id).toBe('srv-1')
    expect(calls.serverInserts).toBe(1)
    expect(calls.membershipInserts).toBe(1)
    expect(store.servers.map(s => s.id)).toEqual(['srv-1'])
  })

  it('does not retry the insert when it fails', async () => {
    const calls = mockTables({ serverInsertError: { message: 'denied' } })
    const store = useServerChannelStore()

    await expect(store.createServer({ name: 'New', owner: 'user-1' })).rejects.toThrow('denied')

    expect(calls.serverInserts).toBe(1)
    expect(calls.membershipInserts).toBe(0)
    expect(store.servers).toEqual([])
  })

  it('removes the new server instead of creating another when membership fails', async () => {
    const calls = mockTables({ membershipError: { code: '42501', message: 'rls' } })
    const store = useServerChannelStore()

    await expect(store.createServer({ name: 'New', owner: 'user-1' })).rejects.toBeTruthy()

    expect(calls.serverInserts).toBe(1)
    expect(calls.serverDeletes).toEqual(['srv-1'])
    expect(store.servers).toEqual([])
  })
})
