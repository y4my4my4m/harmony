import { describe, it, expect, vi, afterEach } from 'vitest'
import { ChannelCloseBackoff, channelRetryDelay, isChannelRefusal } from '../realtimeRefusal'

describe('isChannelRefusal', () => {
  it("knows Realtime's authorization refusal, and nothing else", () => {
    expect(isChannelRefusal(new Error('Unauthorized: You do not have permissions to read from this Channel topic: server-presence:x'))).toBe(true)
    expect(isChannelRefusal('Unauthorized: You do not have permissions to read from this Channel topic: user:y')).toBe(true)
    expect(isChannelRefusal(new Error('timeout'))).toBe(false)
    expect(isChannelRefusal(undefined)).toBe(false)
  })
})

describe('channelRetryDelay', () => {
  it('starts at 5 s and doubles to a 60 s ceiling', () => {
    expect([0, 1, 2, 3, 4, 10].map(channelRetryDelay)).toEqual([5000, 10000, 20000, 40000, 60000, 60000])
  })
})

describe('ChannelCloseBackoff', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('adds up to half of channelRetryDelay at random', () => {
    const random = vi.spyOn(Math, 'random')
    const b = new ChannelCloseBackoff()
    random.mockReturnValue(0)
    expect(b.next(0)).toBe(5000)
    random.mockReturnValue(0.999999)
    expect(b.next(0)).toBeCloseTo(15000, 0)
  })

  it('doubles while closes follow short joins, and starts over after 30 s joined', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const b = new ChannelCloseBackoff()
    expect(b.next(0)).toBe(5000)
    b.joined(10_000)
    expect(b.next(20_000)).toBe(10000)
    b.joined(30_000)
    expect(b.next(59_999)).toBe(20000)
    b.joined(60_000)
    expect(b.next(90_000)).toBe(5000)
  })
})
