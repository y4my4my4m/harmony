import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one send path of call signals (voice rooms, DM calls, easter eggs): send_signal, which names
// the sender (20261124100001), or the client's broadcast on an instance without it. The capability
// list is read at the app's start: an instance that gains send_signal while the app runs is found
// by asking for it.

const capabilities = vi.hoisted(() => ({ relay: true }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: (name: string) => name === 'signal-relay' && capabilities.relay }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))

let sendSignal: typeof import('../signalRelay').sendSignal
let relaysSignals: typeof import('../signalRelay').relaysSignals

const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.send_signal' } }
const ok = { data: null, error: null }
const accept = (broadcast: () => unknown) => sendSignal('dm-call:c1', 'call-signal', { type: 'accept', callType: 'voice' }, broadcast)

beforeEach(async () => {
  vi.useRealTimers()
  capabilities.relay = true
  rpc.mockReset().mockResolvedValue(ok)
  vi.resetModules()
  ;({ sendSignal, relaysSignals } = await import('../signalRelay'))
})

describe('sendSignal', () => {
  it('sends through send_signal and broadcasts nothing itself', async () => {
    const broadcast = vi.fn()
    await sendSignal('dm-call:c1', 'call-signal', { type: 'accept', callType: 'voice' }, broadcast)
    expect(rpc).toHaveBeenCalledWith('send_signal', { p_topic: 'dm-call:c1', p_event: 'call-signal', p_payload: { type: 'accept', callType: 'voice' } })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('throws the refusal, which names its limit', async () => {
    const refusal = { message: 'ANTISPAM_RATE_LIMITED:12', code: 'P0001', details: '{"kind": "signal", "limit": 300, "window_seconds": 60}' }
    rpc.mockResolvedValue({ data: null, error: refusal })
    await expect(sendSignal('harmony-voice-r1', 'signals', { messages: [{ type: 'offer' }] }, () => {})).rejects.toBe(refusal)
  })

  it('broadcasts on an instance without send_signal, and does not ask for it on every signal', async () => {
    vi.useFakeTimers()
    capabilities.relay = false
    rpc.mockResolvedValue(MISSING)
    const broadcast = vi.fn(() => 'ok')
    await sendSignal('easter-egg:r1', 'activate', { type: 'megaman' }, broadcast)
    await accept(broadcast)
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(relaysSignals()).toBe(false)

    vi.advanceTimersByTime(10_001)
    await accept(broadcast)
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(broadcast).toHaveBeenCalledTimes(3)
  })

  it('an instance that gained send_signal since the app started relays, whatever the stored capabilities say', async () => {
    capabilities.relay = false
    const broadcast = vi.fn()
    await accept(broadcast)
    expect(rpc).toHaveBeenCalledWith('send_signal', { p_topic: 'dm-call:c1', p_event: 'call-signal', p_payload: { type: 'accept', callType: 'voice' } })
    expect(broadcast).not.toHaveBeenCalled()
    expect(relaysSignals()).toBe(true)
  })

  it('a broadcast the upgraded instance does not take goes through send_signal', async () => {
    capabilities.relay = false
    rpc.mockResolvedValueOnce(MISSING)
    await accept(() => 'ok')
    rpc.mockResolvedValue(ok)
    await accept(() => 'timed out')
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(relaysSignals()).toBe(true)
  })

  it('a signal nothing took is an error, not silence', async () => {
    capabilities.relay = false
    rpc.mockResolvedValue(MISSING)
    await expect(accept(() => 'timed out')).rejects.toThrow('timed out')
    await expect(accept(() => 'error')).rejects.toThrow('error')
  })

  it('a listed capability with the function absent broadcasts', async () => {
    rpc.mockResolvedValue(MISSING)
    const broadcast = vi.fn(() => 'ok')
    await accept(broadcast)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})

describe('easter eggs', () => {
  it('an activation names only its type; the database names the member', async () => {
    vi.resetModules()
    vi.doMock('@/services/rebuildingChannel', () => ({
      openRebuildingChannel: () => ({ send: vi.fn(async () => 'ok'), close: vi.fn(async () => {}) }),
    }))
    const { easterEggService } = await import('../EasterEggService')
    easterEggService.initialize('room-1', 'me')
    easterEggService.activate('megaman', 'someone-else')
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled())
    expect(rpc).toHaveBeenCalledWith('send_signal', { p_topic: 'easter-egg:room-1', p_event: 'activate', p_payload: { type: 'megaman' } })
    easterEggService.cleanup()
  })
})
