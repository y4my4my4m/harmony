import { describe, expect, it, vi } from 'vitest'
import { categoryFlagProperties, channelFlagProperties, flagProperties, hostFlagsOf } from '../activitypub/channelFlags.js'

describe('flagProperties', () => {
  it('omits a false flag, and a property with no flag', () => {
    expect(flagProperties({ messages: false, voice: false, is_private: false })).toEqual({})
    expect(flagProperties(undefined)).toEqual({})
    expect(flagProperties({ messages: true, voice: false })).toEqual({ 'harmony:encryption': { messages: true } })
  })

  it('carries each flag', () => {
    expect(flagProperties({ messages: true, voice: true, is_private: true })).toEqual({
      'harmony:encryption': { messages: true, voice: true },
      'harmony:private': true,
    })
  })
})

describe('hostFlagsOf', () => {
  it('reads what a document carries', () => {
    expect(hostFlagsOf({ 'harmony:encryption': { messages: true, voice: true }, 'harmony:private': true }))
      .toEqual({ messages: true, voice: true, private: true })
  })

  it('reads an absent property as no flag, which clears a stored one', () => {
    expect(hostFlagsOf({ name: 'general' })).toEqual({})
    expect(hostFlagsOf(null)).toEqual({})
  })

  it('takes nothing but true', () => {
    expect(hostFlagsOf({ 'harmony:encryption': { messages: 'yes', voice: 1, other: true }, 'harmony:private': 'true' })).toEqual({})
    expect(hostFlagsOf({ 'harmony:encryption': 'on' })).toEqual({})
  })

  it('round-trips flagProperties', () => {
    const values = { messages: true, voice: false, is_private: true }
    expect(hostFlagsOf(flagProperties(values))).toEqual({ messages: true, private: true })
  })
})

describe('reads', () => {
  it('maps a row to its properties, a plain channel to none', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { channel_id: 'a', messages: true, voice: false, is_private: false },
        { channel_id: 'b', messages: false, voice: false, is_private: false },
      ],
      error: null,
    })
    const flags = await channelFlagProperties({ rpc } as any, ['a', 'b'])
    expect(rpc).toHaveBeenCalledWith('channel_host_flags', { p_channel_ids: ['a', 'b'] })
    expect(flags.get('a')).toEqual({ 'harmony:encryption': { messages: true } })
    expect(flags.get('b')).toEqual({})
  })

  it('asks nothing for no id', async () => {
    const rpc = vi.fn()
    expect((await channelFlagProperties({ rpc } as any, [])).size).toBe(0)
    expect((await categoryFlagProperties({ rpc } as any, [])).size).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('throws on a failed read: a document without the properties clears a copy\'s flags', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } })
    await expect(channelFlagProperties({ rpc } as any, ['a'])).rejects.toThrow('down')
    await expect(categoryFlagProperties({ rpc } as any, ['a'])).rejects.toThrow('down')
  })

  it('reads a category as private alone', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ category_id: 'c', is_private: true }], error: null })
    const flags = await categoryFlagProperties({ rpc } as any, ['c'])
    expect(rpc).toHaveBeenCalledWith('category_host_flags', { p_category_ids: ['c'] })
    expect(flags.get('c')).toEqual({ 'harmony:private': true })
  })
})
