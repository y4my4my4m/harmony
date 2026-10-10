import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const SERVER = '55555555-0000-0000-0000-000000000005'
const CHANNEL = '66666666-0000-0000-0000-000000000006'
const ME = '11111111-0000-0000-0000-000000000001'
const BOB = '22222222-0000-0000-0000-000000000002'
const SOUND = 'b1160000-0000-0000-0000-000000000001'

const voice = vi.hoisted(() => ({ state: null as any }))
const webrtc = vi.hoisted(() => ({ sendSoundboard: vi.fn() }))
const player = vi.hoisted(() => ({ play: vi.fn(), stopAll: vi.fn() }))
const settings = vi.hoisted(() => ({ soundboardVolume: 100, soundboardMuted: false }))
const mixer = vi.hoisted(() => ({ master: 100, muted: new Set<string>() }))
const perms = vi.hoisted(() => ({ value: {} as Record<string, boolean> }))
const listSounds = vi.hoisted(() => vi.fn())

vi.mock('@/services/webrtcManager', () => ({ webrtcManager: webrtc }))
vi.mock('@/services/RoleService', () => ({
  Permission: { ADMINISTRATOR: 'ADMINISTRATOR', USE_SOUNDBOARD: 'USE_SOUNDBOARD', SPEAK: 'SPEAK' },
  roleService: { getUserPermissions: vi.fn(async () => perms.value) },
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
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice.state }))
vi.mock('@/supabase', () => ({ supabase: {} }))

import { useSoundboardStore } from '../soundboard'
import { buildSoundboardMessage } from '@/services/soundboard/protocol'

const horn = {
  id: SOUND, serverId: SERVER, name: 'Horn', emoji: '📯', volume: 0.5, durationMs: 1200,
  url: 'https://cdn.test/horn.ogg', storagePath: `${SERVER}/horn.ogg`,
}

const fromBob = (soundId = SOUND, overrides: Record<string, unknown> = {}) => ({
  userId: BOB,
  message: buildSoundboardMessage(soundId, SERVER, BOB),
  granted: null,
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
  listSounds.mockReset()
  listSounds.mockResolvedValue([horn])
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
    expect(store.play({ ...horn, serverId: '77777777-0000-0000-0000-000000000007' })).toBe(false)
    expect(webrtc.sendSoundboard).not.toHaveBeenCalled()
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
