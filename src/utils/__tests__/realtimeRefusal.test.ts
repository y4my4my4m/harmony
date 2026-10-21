import { describe, it, expect } from 'vitest'
import { channelRetryDelay, isChannelRefusal } from '../realtimeRefusal'

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
