import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../config/supabase.js', () => ({ supabase: { rpc: mocks.rpc }, config: {} }))

import { UploadReservation } from '../uploadReservation.js'

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('UploadReservation', () => {
  it('claims and raises under one id of its own, and releases it', async () => {
    const reservation = new UploadReservation(CHANNEL)
    expect(await reservation.claim(10)).toBe(true)
    expect(await reservation.claim(20)).toBe(true)
    await reservation.release()
    const [[, first], [, raised], [fn, released]] = mocks.rpc.mock.calls
    expect(first).toEqual({ p_reservation_id: expect.stringMatching(/^[0-9a-f-]{36}$/), p_channel_id: CHANNEL, p_bytes: 10, p_avatar_bot_id: null, p_max_avatars: null })
    expect(raised).toEqual({ ...first, p_bytes: 20 })
    expect([fn, released]).toEqual(['bridge_upload_release', { p_reservation_id: first.p_reservation_id }])
    expect(new UploadReservation(CHANNEL)).not.toHaveProperty('id', first.p_reservation_id)
  })

  it('names the avatar\'s bot and limit', async () => {
    await new UploadReservation(CHANNEL, { botId: BOT, max: 3 }).claim(1)
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_avatar_bot_id: BOT, p_max_avatars: 3 })
  })

  it('answers true only for true, and throws when the claim cannot be asked', async () => {
    const reservation = new UploadReservation(CHANNEL)
    for (const data of [false, null]) {
      mocks.rpc.mockResolvedValueOnce({ data, error: null })
      expect(await reservation.claim(1)).toBe(false)
    }
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'function not found' } })
    await expect(reservation.claim(1)).rejects.toThrow('bridge_upload_reserve failed: function not found')
  })

  it('releases a claim whose answer was lost, once, and never throws', async () => {
    const reservation = new UploadReservation(CHANNEL)
    await reservation.release()
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.rpc.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(reservation.claim(1)).rejects.toThrow('socket hang up')
    mocks.rpc.mockRejectedValueOnce(new Error('socket hang up'))
    await reservation.release()
    expect(console.warn).toHaveBeenCalledWith('bridge_upload_release failed: socket hang up')
    await reservation.release()
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })
})
