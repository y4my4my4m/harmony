import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { ServerTemplate } from '@/utils/serverTemplate'

const TEMPLATE: ServerTemplate = { format: 'harmony.server-template', version: 1 }
const SERVER = { id: 'srv-t', name: 'From template', owner: 'user-1' }

function mockServerRead(result: { data: unknown; error: unknown }) {
  const eq = vi.fn(() => ({ single: async () => result }))
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    if (table !== 'servers') throw new Error(`unexpected table ${table}`)
    return { select: () => ({ eq }) }
  }) as any)
  return eq
}

describe('useServerChannelStore.createServerFromTemplate', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.from).mockReset()
    vi.mocked(supabase.rpc).mockReset()
  })

  it('calls the RPC once with the name and template, then lists the new server', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'srv-t', error: null } as any)
    const eq = mockServerRead({ data: { ...SERVER }, error: null })
    const store = useServerChannelStore()

    const created = await store.createServerFromTemplate('From template', TEMPLATE)

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('create_server_from_template', {
      p_name: 'From template',
      p_template: TEMPLATE,
    })
    expect(eq).toHaveBeenCalledWith('id', 'srv-t')
    expect(created.id).toBe('srv-t')
    expect(store.servers.map(s => s.id)).toEqual(['srv-t'])
  })

  it('does not add the server twice when the realtime join arrived first', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'srv-t', error: null } as any)
    mockServerRead({ data: { ...SERVER }, error: null })
    const store = useServerChannelStore()
    store.servers.push({ ...SERVER } as any)

    await store.createServerFromTemplate('From template', TEMPLATE)

    expect(store.servers.map(s => s.id)).toEqual(['srv-t'])
  })

  it('surfaces the refusal and lists nothing', async () => {
    const refusal = { message: 'TEMPLATE_INVALID: channels[0].type is an integer from 0 to 1', code: '22023' }
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: refusal } as any)
    const store = useServerChannelStore()

    await expect(store.createServerFromTemplate('Bad', TEMPLATE)).rejects.toBe(refusal)

    expect(supabase.from).not.toHaveBeenCalled()
    expect(store.servers).toEqual([])
  })
})
