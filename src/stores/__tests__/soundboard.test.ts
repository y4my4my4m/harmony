import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const SERVER = '55555555-0000-0000-0000-000000000005'
const CHANNEL = '66666666-0000-0000-0000-000000000006'
const ME = '11111111-0000-0000-0000-000000000001'
const BOB = '22222222-0000-0000-0000-000000000002'
const SOUND = 'b1160000-0000-0000-0000-000000000001'
const OTHER = '77777777-0000-0000-0000-000000000007'
const CLAP = 'b1260000-0000-0000-0000-000000000002'

const voice = vi.hoisted(() => ({ state: null as any }))
const webrtc = vi.hoisted(() => ({ sendSoundboard: vi.fn() }))
const player = vi.hoisted(() => ({ play: vi.fn(), stopAll: vi.fn() }))
const settings = vi.hoisted(() => ({ soundboardVolume: 100, soundboardMuted: false }))
const mixer = vi.hoisted(() => ({ master: 100, muted: new Set<string>() }))
const perms = vi.hoisted(() => ({ value: {} as Record<string, boolean> }))
const listSounds = vi.hoisted(() => vi.fn())
const listLibrary = vi.hoisted(() => vi.fn())
const resolveSound = vi.hoisted(() => vi.fn())
const getPerms = vi.hoisted(() => vi.fn())

vi.mock('@/services/webrtcManager', () => ({ webrtcManager: webrtc }))
vi.mock('@/services/RoleService', () => ({
  Permission: {
    ADMINISTRATOR: 'ADMINISTRATOR', USE_SOUNDBOARD: 'USE_SOUNDBOARD', SPEAK: 'SPEAK',
    USE_EXTERNAL_SOUNDS: 'USE_EXTERNAL_SOUNDS',
  },
  roleService: { getUserPermissions: getPerms },
}))
vi.mock('@/services/VoiceSettingsService', () => ({
  VoiceSettingsService: { getAll: () => ({ ...settings }) },
  normalizeSoundboardVolume: (v: number) => v,
}))
vi.mock('@/services/voice/remoteAudioMixer', () => ({
  remoteAudioMixer: {
    getMasterVolume: () => mixer.master,
    isLocalMuted: (userId: string) => mixer.muted.has(userId),
  },
}))
vi.mock('@/services/soundboard/player', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/soundboard/player')>()),
  soundboardPlayer: player,
}))
vi.mock('@/services/soundboard/sounds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/soundboard/sounds')>()),
  listServerSounds: listSounds,
  listSoundboardLibrary: listLibrary,
  resolveSoundboardSound: resolveSound,
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice.state }))
vi.mock('@/supabase', () => ({ supabase: {} }))

import { useSoundboardStore } from '../soundboard'
import { buildSoundboardMessage } from '@/services/soundboard/protocol'

const horn = {
  id: SOUND, serverId: SERVER, name: 'Horn', emoji: '📯', volume: 0.5, durationMs: 1200,
  url: 'https://cdn.test/horn.ogg', storagePath: `${SERVER}/horn.ogg`,
}

const clap = {
  id: CLAP, serverId: OTHER, name: 'Clap', emoji: '👏', volume: 0.6, durationMs: 1500,
  url: 'https://cdn.test/clap.ogg', storagePath: `${OTHER}/clap.ogg`,
}

const fromBob = (soundId = SOUND, overrides: Record<string, unknown> = {}) => ({
  userId: BOB,
  message: buildSoundboardMessage(soundId, SERVER, BOB),
  granted: null,
  ...overrides,
})

const externalFromBob = (overrides: Record<string, unknown> = {}) => ({
  userId: BOB,
  message: buildSoundboardMessage(CLAP, SERVER, BOB, OTHER),
  granted: true,
  externalGranted: true,
  ...overrides,
})

beforeEach(() => {
  vi.useRealTimers()
  setActivePinia(createPinia())
  voice.state = reactive({
    isConnected: true,
    isFederatedChannel: false,
    currentServerId: SERVER,
    currentChannelId: CHANNEL,
    localState: { userId: ME, isDeafened: false },
    allUsers: [{ userId: BOB }],
  })
  webrtc.sendSoundboard.mockReset()
  player.play.mockReset()
  settings.soundboardVolume = 100
  settings.soundboardMuted = false
  mixer.master = 100
  mixer.muted.clear()
  perms.value = { USE_SOUNDBOARD: true, SPEAK: true }
  getPerms.mockReset()
  getPerms.mockImplementation(async () => perms.value)
  listSounds.mockReset()
  listSounds.mockResolvedValue([horn])
  listLibrary.mockReset()
  listLibrary.mockResolvedValue([])
  resolveSound.mockReset()
  resolveSound.mockResolvedValue(clap)
  // The receive limiter outlives a store instance.
  useSoundboardStore().leaveCall()
  player.stopAll.mockReset()
})

describe('currentChannel', () => {
  it('is the server voice channel this client is in', () => {
    expect(useSoundboardStore().currentChannel()).toEqual({ serverId: SERVER, channelId: CHANNEL, selfId: ME })
  })

  it('is absent in DM calls, remote servers, and outside a call', () => {
    const store = useSoundboardStore()
    voice.state.currentServerId = 'dm'
    expect(store.currentChannel()).toBeNull()
    voice.state.currentServerId = SERVER
    voice.state.isFederatedChannel = true
    expect(store.currentChannel()).toBeNull()
    voice.state.isFederatedChannel = false
    voice.state.isConnected = false
    expect(store.currentChannel()).toBeNull()
  })
})

describe('refreshPermission', () => {
  it('needs USE_SOUNDBOARD and SPEAK in the channel', async () => {
    const store = useSoundboardStore()
    await expect(store.refreshPermission()).resolves.toBe(true)
    perms.value = { USE_SOUNDBOARD: true, SPEAK: false }
    await expect(store.refreshPermission()).resolves.toBe(false)
    perms.value = { USE_SOUNDBOARD: false, SPEAK: true }
    await expect(store.refreshPermission()).resolves.toBe(false)
    perms.value = { ADMINISTRATOR: true }
    await expect(store.refreshPermission()).resolves.toBe(true)
  })

  it('grants external sounds with USE_EXTERNAL_SOUNDS on top of the soundboard', async () => {
    const store = useSoundboardStore()
    await store.refreshPermission()
    expect(store.externalPermitted).toBe(false)
    perms.value = { USE_SOUNDBOARD: true, SPEAK: true, USE_EXTERNAL_SOUNDS: true }
    await store.refreshPermission()
    expect(store.externalPermitted).toBe(true)
    perms.value = { USE_SOUNDBOARD: false, SPEAK: true, USE_EXTERNAL_SOUNDS: true }
    await store.refreshPermission()
    expect(store.externalPermitted).toBe(false)
  })
})

describe('loadLibrary', () => {
  it('keeps the caller\'s sharing servers, and the last list when the request fails', async () => {
    const library = [{ id: OTHER, name: 'Echo', icon: null, sounds: [clap] }]
    listLibrary.mockResolvedValueOnce(library)
    const store = useSoundboardStore()
    await expect(store.loadLibrary()).resolves.toEqual(library)
    listLibrary.mockRejectedValueOnce(new Error('offline'))
    await expect(store.loadLibrary()).resolves.toEqual(library)
  })
})

describe('play', () => {
  it('sends the play, plays it locally and starts the cooldown', async () => {
    const store = useSoundboardStore()
    await store.refreshPermission()
    expect(store.play(horn)).toBe(true)
    expect(webrtc.sendSoundboard).toHaveBeenCalledWith(buildSoundboardMessage(SOUND, SERVER, ME))
    expect(player.play).toHaveBeenCalledWith(horn.url, 0.5)
    expect(store.cooldownRemaining()).toBeGreaterThan(2900)
    expect(store.recentPlays.map((p) => p.userId)).toEqual([ME])

    expect(store.play(horn)).toBe(false)
    expect(webrtc.sendSoundboard).toHaveBeenCalledTimes(1)
  })

  it('plays again once the cooldown passes', async () => {
    vi.useFakeTimers()
    const store = useSoundboardStore()
    await store.refreshPermission()
    store.play(horn)
    vi.advanceTimersByTime(3000)
    expect(store.play(horn)).toBe(true)
    expect(webrtc.sendSoundboard).toHaveBeenCalledTimes(2)
  })

  it('is refused without the permission, while deafened, or for another server\'s sound', async () => {
    const store = useSoundboardStore()
    expect(store.play(horn)).toBe(false)
    await store.refreshPermission()
    voice.state.localState.isDeafened = true
    expect(store.play(horn)).toBe(false)
    voice.state.localState.isDeafened = false
    expect(store.play(clap)).toBe(false)
    expect(webrtc.sendSoundboard).not.toHaveBeenCalled()
  })

  it('plays another server\'s sound with USE_EXTERNAL_SOUNDS, naming its server', async () => {
    perms.value = { USE_SOUNDBOARD: true, SPEAK: true, USE_EXTERNAL_SOUNDS: true }
    const store = useSoundboardStore()
    await store.refreshPermission()
    expect(store.isExternal(clap)).toBe(true)
    expect(store.isExternal(horn)).toBe(false)
    expect(store.play(clap)).toBe(true)
    expect(webrtc.sendSoundboard).toHaveBeenCalledWith(buildSoundboardMessage(CLAP, SERVER, ME, OTHER))
    expect(webrtc.sendSoundboard.mock.calls[0][0]).toMatchObject({ soundServerId: OTHER })
    expect(player.play).toHaveBeenCalledWith(clap.url, 0.6)
  })

  it('names no sound server for the channel\'s own sounds', async () => {
    const store = useSoundboardStore()
    await store.refreshPermission()
    store.play(horn)
    expect(webrtc.sendSoundboard.mock.calls[0][0]).not.toHaveProperty('soundServerId')
  })

  it('sends but stays silent locally when the soundboard is muted', async () => {
    settings.soundboardMuted = true
    const store = useSoundboardStore()
    await store.refreshPermission()
    expect(store.play(horn)).toBe(true)
    expect(webrtc.sendSoundboard).toHaveBeenCalled()
    expect(player.play).not.toHaveBeenCalled()
  })
})

describe('receive', () => {
  it('plays a server sound from a participant at the listener\'s levels', async () => {
    settings.soundboardVolume = 50
    mixer.master = 150
    const store = useSoundboardStore()
    await store.receive(fromBob())
    expect(player.play).toHaveBeenCalledWith(horn.url, 0.375)
    expect(store.recentPlays).toMatchObject([{ userId: BOB, soundId: SOUND, name: 'Horn', emoji: '📯' }])
  })

  it('plays built-in sounds without a lookup', async () => {
    const store = useSoundboardStore()
    await store.receive(fromBob('default:ding'))
    expect(listSounds).not.toHaveBeenCalled()
    expect(player.play).toHaveBeenCalledWith('/assets/sounds/soundboard/ding.mp3', 1)
  })

  it('refetches the list once for a sound it does not know', async () => {
    const store = useSoundboardStore()
    store.setServerSounds(SERVER, [])
    store.loadedAt[SERVER] = 0
    await store.receive(fromBob())
    expect(listSounds).toHaveBeenCalledTimes(1)
    expect(player.play).toHaveBeenCalledTimes(1)
  })

  it('drops a sound the server does not have', async () => {
    listSounds.mockResolvedValue([])
    const store = useSoundboardStore()
    await store.receive(fromBob('b1160000-0000-0000-0000-0000000000ff'))
    expect(player.play).not.toHaveBeenCalled()
    expect(store.recentPlays).toEqual([])
  })

  it('drops plays the protocol refuses', async () => {
    const store = useSoundboardStore()
    await store.receive(fromBob(SOUND, { granted: false }))
    await store.receive({ ...fromBob(), userId: '33333333-0000-0000-0000-000000000003' })
    await store.receive({ ...fromBob(), message: buildSoundboardMessage(SOUND, '77777777-0000-0000-0000-000000000007', BOB) })
    voice.state.currentServerId = 'dm'
    await store.receive(fromBob())
    expect(player.play).not.toHaveBeenCalled()
  })

  it('drops a flood from one sender', async () => {
    const store = useSoundboardStore()
    await store.receive(fromBob())
    await store.receive(fromBob())
    await store.receive(fromBob('default:ding'))
    expect(player.play).toHaveBeenCalledTimes(1)
  })

  it('shows but does not play while deafened, muted, or with the sender muted', async () => {
    const store = useSoundboardStore()
    voice.state.localState.isDeafened = true
    await store.receive(fromBob())
    store.leaveCall()
    voice.state.localState.isDeafened = false
    settings.soundboardMuted = true
    await store.receive(fromBob())
    store.leaveCall()
    settings.soundboardMuted = false
    mixer.muted.add(BOB)
    await store.receive(fromBob())
    expect(player.play).not.toHaveBeenCalled()
    expect(store.recentPlays).toHaveLength(1)
  })

  it('expires the indicator', async () => {
    vi.useFakeTimers()
    const store = useSoundboardStore()
    await store.receive(fromBob('default:ding'))
    expect(store.recentPlays).toHaveLength(1)
    vi.advanceTimersByTime(4000)
    expect(store.recentPlays).toHaveLength(0)
  })
})

describe('receive external', () => {
  it('resolves another server\'s sound through the resolver and plays it', async () => {
    const store = useSoundboardStore()
    await store.receive(externalFromBob())
    expect(resolveSound).toHaveBeenCalledWith(CLAP, SERVER)
    expect(listSounds).not.toHaveBeenCalled()
    expect(player.play).toHaveBeenCalledWith(clap.url, 0.6)
    expect(store.recentPlays).toMatchObject([{ userId: BOB, soundId: CLAP, name: 'Clap' }])
  })

  it('reuses a resolved sound', async () => {
    vi.useFakeTimers()
    const store = useSoundboardStore()
    await store.receive(externalFromBob())
    vi.advanceTimersByTime(3000)
    await store.receive(externalFromBob())
    expect(resolveSound).toHaveBeenCalledTimes(1)
    expect(player.play).toHaveBeenCalledTimes(2)
  })

  it('drops it when the token withholds USE_EXTERNAL_SOUNDS', async () => {
    const store = useSoundboardStore()
    await store.receive(externalFromBob({ externalGranted: false }))
    expect(resolveSound).not.toHaveBeenCalled()
    expect(player.play).not.toHaveBeenCalled()
  })

  it('checks the sender\'s channel permissions when no token says', async () => {
    const store = useSoundboardStore()
    perms.value = { USE_SOUNDBOARD: true, SPEAK: true }
    await store.receive(externalFromBob({ granted: null, externalGranted: null }))
    expect(getPerms).toHaveBeenCalledWith(BOB, SERVER, CHANNEL)
    expect(player.play).not.toHaveBeenCalled()

    store.leaveCall()
    perms.value = { USE_SOUNDBOARD: true, SPEAK: true, USE_EXTERNAL_SOUNDS: true }
    await store.receive(externalFromBob({ granted: null, externalGranted: null }))
    expect(player.play).toHaveBeenCalledTimes(1)
  })

  it('drops a sound that does not resolve: deleted, or its server does not share', async () => {
    resolveSound.mockResolvedValue(null)
    const store = useSoundboardStore()
    await store.receive(externalFromBob())
    expect(player.play).not.toHaveBeenCalled()
    expect(store.recentPlays).toEqual([])
  })

  it('drops a sound whose server is not the one the play names', async () => {
    resolveSound.mockResolvedValue({ ...clap, serverId: '88888888-0000-0000-0000-000000000008' })
    const store = useSoundboardStore()
    await store.receive(externalFromBob())
    expect(player.play).not.toHaveBeenCalled()
  })

  it('drops an unmarked play of another server\'s sound', async () => {
    listSounds.mockResolvedValue([horn, clap])
    const store = useSoundboardStore()
    await store.receive(fromBob(CLAP))
    expect(player.play).not.toHaveBeenCalled()
  })
})

describe('leaveCall', () => {
  it('stops playback and resets the per-call state', async () => {
    const store = useSoundboardStore()
    await store.refreshPermission()
    await store.receive(fromBob())
    store.leaveCall()
    expect(player.stopAll).toHaveBeenCalled()
    expect(store.permitted).toBe(false)
    expect(store.recentPlays).toEqual([])
    await store.receive(fromBob())
    expect(player.play).toHaveBeenCalledTimes(2)
  })
})
