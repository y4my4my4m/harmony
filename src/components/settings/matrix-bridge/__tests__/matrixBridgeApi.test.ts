/** matrixBridgeApi.ts: RPC names, arguments and the shapes accepted back. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  configureMatrixBridge,
  fetchServerMatrixBridges,
  setMatrixBridgeSenderMode,
  unconfigureMatrixBridge,
} from '../matrixBridgeApi'

const rpc = vi.mocked(supabase.rpc)
const pair = { bot_id: 'bot', channel_id: 'channel', channel_name: 'general', room_id: '!room:hs', sender_mode: 'ghost' }

beforeEach(() => rpc.mockReset())

describe('matrixBridgeApi', () => {
  it('lists pairs and keeps only their known fields', async () => {
    rpc.mockResolvedValueOnce({ data: [{ ...pair, extra: 'x' }], error: null } as never)
    expect(await fetchServerMatrixBridges('s1')).toEqual([pair])
    expect(rpc).toHaveBeenCalledWith('get_server_matrix_bridges', { p_server_id: 's1' })
  })

  it.each([
    null,
    {},
    [{ ...pair, room_id: '' }],
    [{ ...pair, bot_id: '' }],
    [{ ...pair, sender_mode: 'both' }],
  ])('refuses the listing %j', async (data) => {
    rpc.mockResolvedValueOnce({ data, error: null } as never)
    await expect(fetchServerMatrixBridges('s1')).rejects.toThrow()
  })

  it('takes the saved pair only for the bot and channel it changed', async () => {
    rpc.mockResolvedValueOnce({ data: pair, error: null } as never)
    expect(await setMatrixBridgeSenderMode('bot', 'channel', 'ghost')).toEqual(pair)
    expect(rpc).toHaveBeenCalledWith('set_matrix_bridge_sender_mode', { p_bot_id: 'bot', p_channel_id: 'channel', p_sender_mode: 'ghost' })
    rpc.mockResolvedValueOnce({ data: { ...pair, channel_id: 'other' }, error: null } as never)
    await expect(setMatrixBridgeSenderMode('bot', 'channel', 'ghost')).rejects.toThrow()
  })

  it('configures and unconfigures a bot on a server', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null } as never)
    expect(await configureMatrixBridge('bot', 's1', ['c1', 'c2'])).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith('configure_matrix_bridge', { p_bot_id: 'bot', p_server_id: 's1', p_channel_ids: ['c1', 'c2'] })
    rpc.mockResolvedValueOnce({ data: true, error: null } as never)
    expect(await unconfigureMatrixBridge('bot', 's1')).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith('unconfigure_matrix_bridge', { p_bot_id: 'bot', p_server_id: 's1' })
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'MANAGE_SERVER required', code: '42501' } } as never)
    await expect(unconfigureMatrixBridge('bot', 's1')).rejects.toMatchObject({ code: '42501' })
  })
})
