import { beforeEach, describe, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ supabase: { rpc } }))
import { bridgeChannelPlatform, memberRecipients, messagePrivacySource, messageRecipients, sourceRecipients, visibleMessageIds } from './bridgePrivacy.js'
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
  it('preserves native and interaction attribution without retaining message content or unrelated metadata', async () => {
    const source = { user_id: 'native', bot_id: 'bot', content: ['private'], metadata: {
      secret: 'discard', interaction: { user_id: 'invoker', name: 'weather', options: ['discard'] },
    } }
    expect(messagePrivacySource(source)).toEqual({ user_id: 'native', bot_id: 'bot', metadata: { interaction: { user_id: 'invoker' } } })
    rpc.mockResolvedValue({ data: ['ordinary'], error: null })
    expect(await sourceRecipients(['bridge', 'ordinary'], 'channel', source)).toEqual(['ordinary'])
    expect(rpc).toHaveBeenCalledWith('bridge_source_recipients', {
      p_bot_ids: ['bridge', 'ordinary'], p_channel_id: 'channel', p_source: messagePrivacySource(source),
    })
  })
  it.each([null, false, 'invalid', [], {}, { user_id: null }, { user_id: 'not-a-uuid' }])('never erases a malformed interaction claim %j', interaction => {
    const snapshot = messagePrivacySource({ user_id: null, bot_id: 'bot', metadata: { interaction } })!
    expect(snapshot.metadata).toHaveProperty('interaction')
    expect(messagePrivacySource(snapshot)).toEqual(snapshot)
  })
  it('distinguishes unavailable source from an ordinary bot without an interaction', () => {
    expect(messagePrivacySource(null)).toBeNull()
    expect(messagePrivacySource({ metadata: {} })).toBeNull()
    expect(messagePrivacySource({ user_id: null, bot_id: 'bot', metadata: {} })).toEqual({ user_id: null, bot_id: 'bot', metadata: {} })
  })
  it.each([
    { user_id: null, metadata: {} }, { user_id: null, bot_id: 'bot' },
    { user_id: null, bot_id: 'bot', metadata: ['interaction'] },
    { user_id: null, bot_id: 'bot', metadata: 'interaction' },
  ])('does not turn partial or malformed source attribution into an anonymous bot row %j', source => {
    expect(messagePrivacySource(source)).toBeNull()
  })
  it.each([null, true, ['unrequested'], [1]])('fails closed on malformed source recipients %j', async data => {
    rpc.mockResolvedValue({ data, error: null })
    await expect(sourceRecipients(['bridge'], 'channel', null)).rejects.toThrow('Bridge privacy status unavailable')
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
    expect(await sourceRecipients([], 'c', null)).toEqual([])
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
