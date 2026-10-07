import { describe, it, expect, vi, beforeEach } from 'vitest'

// These paths reached their dependencies through CommonJS require('@/...'), which the
// production bundle keeps as a literal require() that always throws: spatial audio never
// deafened, the emoji broadcast relay never ran, and the federation URL override was ignored.

const spatial = vi.hoisted(() => ({
  setDeafened: vi.fn(),
  status: { isInitialized: true },
  storeEnabled: true,
}))
const emojiStore = vi.hoisted(() => ({ handleEmojiUpdate: vi.fn() }))

vi.mock('livekit-client', () => ({
  setLogLevel: () => {},
  LogLevel: { debug: 0, warn: 1 },
  Track: { Source: { Microphone: 'microphone' } },
  ConnectionState: { Connected: 'connected' },
}))
vi.mock('@/services/spatialAudio', () => ({
  spatialAudioService: {
    setDeafened: spatial.setDeafened,
    getStatus: () => spatial.status,
  },
}))
vi.mock('@/stores/spatialAudio', () => ({
  useSpatialAudioStore: () => ({ settings: { enabled: spatial.storeEnabled } }),
}))
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => emojiStore }))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({ federationApiUrl: 'https://fed.example/api/federation' }),
}))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
vi.mock('@/services/RealtimeApiService', () => ({
  realtimeApiService: { startHeartbeat: vi.fn(), updateStatus: vi.fn(), goOffline: vi.fn(async () => {}), cleanup: vi.fn() },
}))
vi.mock('@/services/ActivityTracker', () => ({ activityTracker: new EventTarget() }))
vi.mock('@/services/unifiedEmojiService', () => ({ loadEmojiData: vi.fn(), isLoaded: { value: true } }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: async () => ({ isAuthenticated: false }), getCurrentProfileId: async () => null },
}))

import { LiveKitWebRTCService } from '@/services/livekitWebRTC'
import { UnifiedWebRTCService } from '@/services/unifiedWebRTC'
import { userDataService } from '@/services/userDataService'
import { activityPubService } from '@/services/activityPubService'

beforeEach(() => {
  spatial.setDeafened.mockClear()
  spatial.status = { isInitialized: true }
  spatial.storeEnabled = true
  emojiStore.handleEmojiUpdate.mockClear()
})

describe('deafen reaches spatial audio', () => {
  it('LiveKit deafen and undeafen set the spatial master output', () => {
    const svc = new LiveKitWebRTCService()
    svc.toggleDeafen()
    svc.toggleDeafen()
    expect(spatial.setDeafened.mock.calls).toEqual([[true], [false]])
  })

  it('P2P undeafen keeps per-peer audio muted while spatial audio plays it', () => {
    const svc = new UnifiedWebRTCService()
    ;(svc as any).broadcastMessage = vi.fn()
    const audioElement = { muted: false } as HTMLAudioElement
    ;(svc as any).connections.set('peer', { userId: 'peer', audioElement })

    svc.toggleDeafen()
    expect(audioElement.muted).toBe(true)
    svc.toggleDeafen()
    expect(audioElement.muted).toBe(true)
    expect(spatial.setDeafened.mock.calls).toEqual([[true], [false]])
  })

  it('P2P undeafen unmutes per-peer audio when spatial audio is off', () => {
    spatial.storeEnabled = false
    const svc = new UnifiedWebRTCService()
    ;(svc as any).broadcastMessage = vi.fn()
    const audioElement = { muted: false } as HTMLAudioElement
    ;(svc as any).connections.set('peer', { userId: 'peer', audioElement })

    svc.toggleDeafen()
    svc.toggleDeafen()
    expect(audioElement.muted).toBe(false)
  })
})

describe('emoji broadcast relay', () => {
  it('hands broadcast emoji changes to the emoji cache', () => {
    const row = { id: 'e1', name: 'blob' }
    ;(userDataService as any).handleEmojiBroadcast({ type: 'emoji:insert', new: row })
    ;(userDataService as any).handleEmojiBroadcast({ type: 'emoji:delete', old: row })
    expect(emojiStore.handleEmojiUpdate.mock.calls).toEqual([
      [{ eventType: 'INSERT', new: row, old: undefined }],
      [{ eventType: 'DELETE', new: undefined, old: row }],
    ])
  })
})

describe('federation proxy URL', () => {
  it('uses the store value, which instance_config may override', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ count: 2 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await activityPubService.fetchRemoteReactions('https://remote.example/notes/1', 'post-1')
      expect(fetchMock).toHaveBeenCalledWith('https://fed.example/api/federation/fetch-reactions', expect.anything())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
