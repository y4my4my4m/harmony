import { beforeEach, describe, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ supabase: { rpc } }))
import { bridgeChannelPlatform, memberRecipients, messageRecipients, visibleMessageIds } from './bridgePrivacy.js'
beforeEach(() => rpc.mockReset())

describe('bridge privacy RPC boundaries', () => {
  it('returns only requested recipients and preserves recipient order', async () => {
    rpc.mockResolvedValue({ data: ['b', 'b'], error: null })
    expect(await messageRecipients(['a', 'b'], 'm')).toEqual(['b'])
    expect(rpc).toHaveBeenCalledWith('bridge_message_recipients', { p_bot_ids: ['a', 'b'], p_message_id: 'm' })
  })
  it('checks current member consent for reaction and deletion snapshots', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    expect(await memberRecipients(['a'], 'channel', 'user')).toEqual([])
    expect(rpc).toHaveBeenCalledWith('bridge_member_recipients', { p_bot_ids: ['a'], p_channel_id: 'channel', p_user_id: 'user' })
  })
  it.each([null, true, ['unrequested'], [1]])('fails closed on malformed message visibility %j', async data => {
    rpc.mockResolvedValue({ data, error: null })
    await expect(visibleMessageIds('b', ['m'])).rejects.toThrow('Bridge privacy status unavailable')
  })
  it('propagates unavailable consent rather than treating it as ordinary-bot access', async () => {
    rpc.mockResolvedValue({ data: ['b'], error: { message: 'offline' } })
    await expect(messageRecipients(['b'], 'm')).rejects.toThrow()
  })
  it('does not query the DB for an empty result set', async () => {
    expect(await visibleMessageIds('b', [])).toEqual(new Set())
    expect(await messageRecipients([], 'm')).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })
  it.each(['matrix', 'discord', null])('recognizes registration %s', async data => {
    rpc.mockResolvedValue({ data, error: null })
    expect(await bridgeChannelPlatform('b', 'c')).toBe(data)
  })
  it.each([undefined, false, 'other'])('fails closed on an unknown registration %j', async data => {
    rpc.mockResolvedValue({ data, error: null })
    await expect(bridgeChannelPlatform('b', 'c')).rejects.toThrow('Bridge registration unavailable')
  })
})
