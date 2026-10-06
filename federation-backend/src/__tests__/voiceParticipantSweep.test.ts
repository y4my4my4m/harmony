import { describe, it, expect, vi, beforeEach } from 'vitest'

// reconcileVoiceNow runs only when LiveKit is configured and clients use it.

const cfg: Record<string, any> = {}
vi.mock('../config/index.js', () => ({ default: cfg }))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/voiceParticipantReconciler.js', () => ({
  reconcileVoiceParticipants: vi.fn(async () => ({ ok: true, checked: 0, removed: 0 })),
}))

const { reconcileVoiceNow } = await import('../services/voiceParticipantSweep.js')
const { reconcileVoiceParticipants } = await import('../services/voiceParticipantReconciler.js')

beforeEach(() => {
  vi.mocked(reconcileVoiceParticipants).mockClear()
  Object.assign(cfg, {
    INSTANCE_DOMAIN: 'harmony.test',
    WEBRTC_MODE: 'hybrid',
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret',
    LIVEKIT_URL: 'ws://livekit:7880',
    VOICE_RECONCILE_INTERVAL_SECONDS: 60,
  })
})

describe('reconcileVoiceNow', () => {
  it('runs against the configured LiveKit', async () => {
    expect(await reconcileVoiceNow({ channelIds: ['c'] })).toEqual({ ok: true, checked: 0, removed: 0 })
    expect(reconcileVoiceParticipants).toHaveBeenCalledWith(
      expect.objectContaining({ instanceDomain: 'harmony.test', channelIds: ['c'] }),
    )
  })

  it('is off when clients never use LiveKit', async () => {
    cfg.WEBRTC_MODE = 'p2p'
    expect((await reconcileVoiceNow()).ok).toBe(false)
    expect(reconcileVoiceParticipants).not.toHaveBeenCalled()
  })

  it('is off when LiveKit is not configured', async () => {
    cfg.LIVEKIT_URL = undefined
    expect((await reconcileVoiceNow()).ok).toBe(false)
    expect(reconcileVoiceParticipants).not.toHaveBeenCalled()
  })
})
