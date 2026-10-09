import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  getSystemChannelChoices,
  getSystemMessageSettings,
  setServerSystemChannel,
} from '@/services/permissionsService'

const rpc = vi.mocked(supabase.rpc)
const from = vi.mocked(supabase.from)

// select/eq/order chain; awaiting the chain or maybeSingle() yields `result`.
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => result)
  chain.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return chain as any
}

beforeEach(() => {
  rpc.mockReset()
  from.mockReset()
})

describe('system message settings', () => {
  it('reads both columns and defaults a server without a settings row', async () => {
    const q = query({ data: { system_channel_id: 'c1', system_messages_enabled: false }, error: null })
    from.mockReturnValue(q)
    expect(await getSystemMessageSettings('s1')).toEqual({ system_channel_id: 'c1', system_messages_enabled: false })
    expect(from).toHaveBeenCalledWith('server_settings')
    expect(q.select).toHaveBeenCalledWith('system_channel_id, system_messages_enabled')
    expect(q.eq).toHaveBeenCalledWith('server_id', 's1')

    from.mockReturnValue(query({ data: null, error: null }))
    expect(await getSystemMessageSettings('s1')).toEqual({ system_channel_id: null, system_messages_enabled: true })
  })

  it('throws a read error', async () => {
    from.mockReturnValue(query({ data: null, error: new Error('permission denied') }))
    await expect(getSystemMessageSettings('s1')).rejects.toThrow('permission denied')
  })

  it('writes through set_server_system_channel, null meaning automatic', async () => {
    rpc.mockResolvedValue({ data: { system_channel_id: null, system_messages_enabled: true }, error: null } as never)
    expect(await setServerSystemChannel('s1', null, true)).toEqual({ system_channel_id: null, system_messages_enabled: true })
    expect(rpc).toHaveBeenCalledWith('set_server_system_channel', {
      p_server_id: 's1',
      p_channel_id: null,
      p_enabled: true,
    })

    rpc.mockResolvedValue({ data: null, error: { message: 'Channel c2 is not a text channel' } } as never)
    await expect(setServerSystemChannel('s1', 'c2', true)).rejects.toMatchObject({
      message: 'Channel c2 is not a text channel',
    })
  })

  it('lists the server\'s text channels in channel order', async () => {
    const q = query({ data: [{ id: 'c1', name: 'general' }], error: null })
    from.mockReturnValue(q)
    expect(await getSystemChannelChoices('s1')).toEqual([{ id: 'c1', name: 'general' }])
    expect(from).toHaveBeenCalledWith('channels')
    expect(q.eq).toHaveBeenCalledWith('server_id', 's1')
    expect(q.eq).toHaveBeenCalledWith('type', 0)
    expect(q.order).toHaveBeenCalledWith('order')
  })
})
