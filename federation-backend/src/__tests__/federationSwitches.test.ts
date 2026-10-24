import { describe, it, expect, vi, beforeEach } from 'vitest'

// The instance's federation switches as the backend reads them (migration 20261028500001).

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ rpc }) }))

const {
  federationSwitches, invalidateFederationSwitches, outboundAllows, resetFederationSwitchesForTests,
} = await import('../services/FederationSwitches.js')

const answer = (inbound: boolean, outbound: boolean) => rpc.mockResolvedValue({ data: [{ inbound, outbound }], error: null })

beforeEach(() => {
  rpc.mockReset()
  resetFederationSwitchesForTests()
})

describe('federationSwitches', () => {
  it('reads the database once per refresh window, and again once invalidated', async () => {
    answer(true, false)
    expect(await federationSwitches()).toEqual({ inbound: true, outbound: false })
    answer(false, false)
    expect(await federationSwitches()).toEqual({ inbound: true, outbound: false })
    expect(rpc).toHaveBeenCalledTimes(1)
    invalidateFederationSwitches()
    expect(await federationSwitches()).toEqual({ inbound: false, outbound: false })
  })

  it('shares one read between concurrent callers', async () => {
    answer(true, true)
    await Promise.all([federationSwitches(), federationSwitches(), federationSwitches()])
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('keeps the last value when the read fails', async () => {
    answer(false, true)
    await federationSwitches()
    invalidateFederationSwitches()
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect(await federationSwitches()).toEqual({ inbound: false, outbound: true })
  })

  it('keeps the last value when the client throws', async () => {
    rpc.mockRejectedValue(new Error('socket hang up'))
    expect(await federationSwitches()).toEqual({ inbound: true, outbound: true })
  })

  it('is both on before anything was read, when the read fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect(await federationSwitches()).toEqual({ inbound: true, outbound: true })
  })
})

describe('outboundAllows', () => {
  it('lets everything out while outbound is on', async () => {
    answer(false, true)
    expect(await outboundAllows({ type: 'Create' })).toBe(true)
  })

  it('drops everything while outbound alone is off, closing Removes and Leaves included', async () => {
    answer(true, false)
    expect(await outboundAllows({ type: 'Create' })).toBe(false)
    expect(await outboundAllows({ type: 'Remove', id: 'https://h.test/servers/s/activities/removal-r1', 'harmony:reason': 'federation_closed' })).toBe(false)
    expect(await outboundAllows({ type: 'Leave', id: 'https://h.test/users/ann/activities/instance-leave-l1' })).toBe(false)
  })

  const closingRemove = { type: 'Remove', id: 'https://h.test/servers/s/activities/removal-r1', 'harmony:reason': 'federation_closed' }
  const closingLeave = { type: 'Leave', id: 'https://h.test/users/ann/activities/instance-leave-l1' }

  it('lets a closed instance send only its closing Removes and Leaves', async () => {
    answer(false, false)
    expect(await outboundAllows(closingRemove)).toBe(true)
    expect(await outboundAllows(closingLeave)).toBe(true)
    expect(await outboundAllows({ ...closingRemove, 'harmony:reason': 'kick' })).toBe(false)
    expect(await outboundAllows({ type: 'Remove', id: 'https://h.test/users/ann/activities/x', target: 'https://h.test/users/ann/featured' })).toBe(false)
    expect(await outboundAllows({ type: 'Leave', id: 'https://h.test/users/ann/activities/x' })).toBe(false)
    expect(await outboundAllows({ type: 'Create' })).toBe(false)
    expect(await outboundAllows(null)).toBe(false)
  })

  it('reads again before dropping a closing activity on a value that says inbound is on', async () => {
    answer(true, false)
    await federationSwitches()
    answer(false, false)
    expect(await outboundAllows(closingLeave)).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
