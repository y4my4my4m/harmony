import { beforeEach, describe, expect, it, vi } from 'vitest'

// The manager picks the room's transport from the instance config alone. A
// client whose SFU connection fails stays out of the call; it does not open
// a P2P session the SFU participants cannot see.

const tokens = vi.hoisted(() => ({
  fetchLiveKitConfig: vi.fn(),
  lastLiveKitConfig: vi.fn(),
}))
const transport = () => ({
  joinChannel: vi.fn(async () => true),
  joinWithToken: vi.fn(async () => true),
  leaveChannel: vi.fn(async () => undefined),
  setTransmitGate: vi.fn(),
  sendSoundboard: vi.fn(),
  on: vi.fn(),
})
const livekit = vi.hoisted(() => ({} as ReturnType<typeof transport>))
const p2p = vi.hoisted(() => ({} as ReturnType<typeof transport>))

vi.mock('../livekitTokens', () => tokens)
vi.mock('../livekitWebRTC', () => ({ livekitWebRTC: livekit, preloadLiveKit: vi.fn() }))
vi.mock('../unifiedWebRTC', () => ({ unifiedWebRTC: p2p }))
vi.mock('../VoiceSettingsService', () => ({ VoiceSettingsService: { getDevices: () => ({ outputDevice: null }) } }))
vi.mock('../voice/remoteAudioMixer', () => ({
  remoteAudioMixer: { setOutputDevice: vi.fn(async () => undefined), reset: vi.fn() },
}))

const configured = { enabled: true, mode: 'hybrid', wsUrl: 'wss://lk.test', allowFederatedVoice: false }
const unconfigured = { enabled: false, mode: 'hybrid', wsUrl: null, allowFederatedVoice: false }

async function manager() {
  vi.resetModules()
  return (await import('../webrtcManager')).webrtcManager
}

beforeEach(() => {
  Object.assign(livekit, transport())
  Object.assign(p2p, transport())
  tokens.fetchLiveKitConfig.mockReset()
  tokens.lastLiveKitConfig.mockReset().mockReturnValue(null)
})

describe('webrtcManager transport selection', () => {
  it('joins the SFU when the instance has LiveKit', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(configured)
    const m = await manager()
    await expect(m.joinChannel('c1', 'u1')).resolves.toBe(true)
    expect(livekit.joinChannel).toHaveBeenCalledWith('c1', 'u1', 'voice_channel', undefined, false)
    expect(p2p.joinChannel).not.toHaveBeenCalled()
    expect(m.getActiveService()).toBe('livekit')
  })

  it('fails the join when the SFU connection fails; no P2P fallback', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(configured)
    livekit.joinChannel.mockImplementation(async () => {
      // livekitWebRTC reports the cause through its error event before resolving false.
      const forward = livekit.on.mock.calls.find(([event]) => event === 'error')?.[1]
      forward?.(new Error('could not establish signal connection'))
      return false
    })
    const m = await manager()
    await expect(m.joinChannel('c1', 'u1')).resolves.toBe(false)
    expect(p2p.joinChannel).not.toHaveBeenCalled()
    expect(m.getActiveService()).toBeNull()
    expect(m.getLastJoinError()).toBe('Could not connect to the voice server: could not establish signal connection')
  })

  it('a silent leave reaches the P2P service as one', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(unconfigured)
    const m = await manager()
    await m.joinChannel('c1', 'u1')
    await m.leaveChannel({ silent: true })
    expect(p2p.leaveChannel).toHaveBeenCalledWith({ silent: true })
    expect(m.getActiveService()).toBeNull()
  })

  it('a failed join leaves its service: a later leave reaches no service', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(unconfigured)
    p2p.joinChannel.mockResolvedValue(false)
    const m = await manager()
    let activeAtLeave: unknown = 'unset'
    p2p.leaveChannel.mockImplementation(async () => { activeAtLeave = m.getActiveService() })
    await expect(m.joinChannel('c1', 'u1')).resolves.toBe(false)
    expect(p2p.leaveChannel).toHaveBeenCalledTimes(1)
    // Its channel-left is not forwarded.
    expect(activeAtLeave).toBeNull()
    expect(m.getLastJoinError()).toBe('Could not connect to the call.')
    await m.leaveChannel()
    expect(p2p.leaveChannel).toHaveBeenCalledTimes(1)
  })

  it('a join that ends after a newer one started leaves the newer one alone', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(unconfigured)
    let endFirst!: (ok: boolean) => void
    p2p.joinChannel
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { endFirst = resolve }))
      .mockResolvedValueOnce(true)
    const m = await manager()
    const first = m.joinChannel('c1', 'u1')
    await vi.waitFor(() => expect(p2p.joinChannel).toHaveBeenCalledTimes(1))
    await m.leaveChannel()
    await expect(m.joinChannel('c2', 'u1')).resolves.toBe(true)
    p2p.leaveChannel.mockClear()
    endFirst(false)
    await expect(first).resolves.toBe(false)
    expect(p2p.leaveChannel).not.toHaveBeenCalled()
    expect(m.getActiveService()).toBe('p2p')
    expect(m.getLastJoinError()).toBeNull()
  })

  it('fails the join when the config cannot be fetched and none was seen before', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(null)
    const m = await manager()
    await expect(m.joinChannel('c1', 'u1')).resolves.toBe(false)
    expect(livekit.joinChannel).not.toHaveBeenCalled()
    expect(p2p.joinChannel).not.toHaveBeenCalled()
    expect(m.getLastJoinError()).toMatch(/settings could not be loaded/)
  })

  it('uses the last fetched config when a refresh fails', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(null)
    tokens.lastLiveKitConfig.mockReturnValue(configured)
    const m = await manager()
    await expect(m.joinChannel('c1', 'u1')).resolves.toBe(true)
    expect(livekit.joinChannel).toHaveBeenCalled()
    expect(p2p.joinChannel).not.toHaveBeenCalled()
  })

  it('uses P2P on an instance without LiveKit', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(unconfigured)
    const m = await manager()
    await expect(m.joinChannel('c1', 'u1')).resolves.toBe(true)
    expect(p2p.joinChannel).toHaveBeenCalledWith('c1', 'u1', undefined)
    expect(livekit.joinChannel).not.toHaveBeenCalled()
    expect(m.getActiveService()).toBe('p2p')
  })

  it('uses P2P in p2p mode even with LiveKit configured', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue({ ...configured, mode: 'p2p' })
    const m = await manager()
    await expect(m.joinChannel('c1', 'u1')).resolves.toBe(true)
    expect(p2p.joinChannel).toHaveBeenCalled()
    expect(livekit.joinChannel).not.toHaveBeenCalled()
  })

  it('consumes the config request started by preloadTransport', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(configured)
    const m = await manager()
    m.preloadTransport()
    await m.joinChannel('c1', 'u1')
    expect(tokens.fetchLiveKitConfig).toHaveBeenCalledTimes(1)
  })

  it('refuses P2P for a room that requires E2EE', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(unconfigured)
    const m = await manager()
    await expect(m.joinChannel('c1', 'u1', 'voice_channel', undefined, true)).resolves.toBe(false)
    expect(p2p.joinChannel).not.toHaveBeenCalled()
  })
})

describe('webrtcManager soundboard', () => {
  it('sends plays on the active transport only', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(unconfigured)
    const m = await manager()
    m.sendSoundboard({ type: 'soundboard' })
    expect(p2p.sendSoundboard).not.toHaveBeenCalled()
    await m.joinChannel('c1', 'u1')
    m.sendSoundboard({ type: 'soundboard' })
    expect(p2p.sendSoundboard).toHaveBeenCalledWith({ type: 'soundboard' })
    expect(livekit.sendSoundboard).not.toHaveBeenCalled()
  })

  it('forwards received plays from the active transport only', async () => {
    tokens.fetchLiveKitConfig.mockResolvedValue(configured)
    const m = await manager()
    const received = vi.fn()
    m.on('soundboard', received)
    await m.joinChannel('c1', 'u1')
    const fromLiveKit = livekit.on.mock.calls.find(([event]) => event === 'soundboard')?.[1]
    const fromP2P = p2p.on.mock.calls.find(([event]) => event === 'soundboard')?.[1]
    fromP2P?.({ userId: 'x', message: {}, granted: null })
    fromLiveKit?.({ userId: 'u2', message: {}, granted: true })
    expect(received).toHaveBeenCalledTimes(1)
    expect(received).toHaveBeenCalledWith({ userId: 'u2', message: {}, granted: true })
  })
})
