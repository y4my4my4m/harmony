import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one send path of call signals (voice rooms, DM calls, easter eggs): send_signal, which names
// the sender (20261124100001), or the client's broadcast on an instance without it.

const capabilities = vi.hoisted(() => ({ relay: true }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: (name: string) => name === 'signal-relay' && capabilities.relay }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))

import { sendSignal } from '../signalRelay'

beforeEach(() => {
  capabilities.relay = true
  rpc.mockReset().mockResolvedValue({ data: null, error: null })
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

  it('broadcasts on an instance without send_signal', async () => {
    capabilities.relay = false
    const broadcast = vi.fn()
    await sendSignal('easter-egg:r1', 'activate', { type: 'megaman' }, broadcast)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalled()
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
