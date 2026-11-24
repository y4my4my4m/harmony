import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// A call is the account's: it ends in this tab on every path that ends the session here. Sign-out in
// this tab leaves it with the session still standing; every other path closes it at once and sends
// nothing. Each path but a replaced account returns to sign-in with the account's state cleared.

const webrtc = vi.hoisted(() => ({ on: vi.fn(), leaveChannel: vi.fn(async (_opts?: { silent?: boolean }) => undefined) }))
const dm = vi.hoisted(() => ({ cleanup: vi.fn(), leaveCall: vi.fn(async () => undefined), endFederatedCall: vi.fn(async () => undefined) }))
const serverUsers = vi.hoisted(() => ({ leaveVoiceChannel: vi.fn(async () => true) }))
const db = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ data: null, error: null })), from: vi.fn() }))
const auth$ = vi.hoisted(() => ({
  event: null as unknown as (event: string, session: unknown) => Promise<void>,
  rejected: null as unknown as (reason: string) => void,
  stored: null as unknown,
  signOut: vi.fn(async () => {}),
}))
const push = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/supabase', () => ({
  onSessionRejected: (listener: (reason: string) => void) => { auth$.rejected = listener; return () => {} },
  signOutAndForget: auth$.signOut,
  signOutEverywhere: vi.fn(async () => {}),
  supabase: {
    rpc: db.rpc,
    from: db.from,
    auth: {
      storageKey: 'sb-test-auth-token',
      getSession: async () => ({ data: { session: auth$.stored }, error: null }),
      onAuthStateChange: (callback: typeof auth$.event) => {
        auth$.event = callback
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      mfa: { listFactors: async () => ({ data: { totp: [{ status: 'verified' }] }, error: null }) },
    },
  },
}))
vi.mock('@/router', () => ({ default: { push } }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ initialize: async () => {} }) }))
vi.mock('@/stores/useFunding', () => ({ useFundingStore: () => ({ load: async () => {} }) }))
vi.mock('@/stores/useOutbox', () => ({ useOutboxStore: () => ({ reset: () => {} }) }))
vi.mock('@/composables/usePushNotifications', () => ({ usePushNotifications: () => ({ detachForLogout: async () => {} }) }))
vi.mock('@/composables/useViewContext', () => ({ markDeviceAway: async () => {} }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: async () => 'me' } }))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: webrtc }))
vi.mock('@/services/voice/remoteAudioMixer', () => ({ clampVolume: (v: number) => v, remoteAudioMixer: { onBlockedChange: vi.fn() } }))
vi.mock('@/services/voice/voiceAudioPrefs', () => ({ loadAudioPrefs: () => ({}), saveMutes: vi.fn(), saveVolumes: vi.fn() }))
vi.mock('@/services/voice/voiceAudioContext', () => ({ closeVoiceAudioContext: vi.fn() }))
vi.mock('@/services/VoiceSettingsService', () => ({ VoiceSettingsService: {}, normalizeOutputVolume: (v: number) => v }))
vi.mock('@/services/spatialAudio', () => ({ spatialAudioService: { destroy: vi.fn() } }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: dm }))
vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => ({ reset: () => {} }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => serverUsers }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [] }) }))
vi.mock('@/stores/soundboard', () => ({ useSoundboardStore: () => ({ leaveCall: vi.fn() }) }))
vi.mock('@/stores/activities', () => ({ useActivitiesStore: () => ({}) }))
vi.mock('@/stores/voiceModeration', () => ({ useVoiceModerationStore: () => ({ clearRoom: vi.fn() }) }))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: vi.fn() }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({}) }))
vi.mock('@/services/voice/voiceAnnouncements', () => ({ voiceAnnouncer: new Proxy({}, { get: () => () => undefined }) }))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: vi.fn() }))
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn(), setCurrentUser: vi.fn(), clearCurrentUser: vi.fn(), getCurrentUser: () => null },
}))

import { useAuthStore } from '@/stores/auth'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`
const session = (id: string, aal = 'aal2') => ({ access_token: jwt({ aal, sub: id, amr: [{ method: 'password' }] }), user: { id } }) as any
const ME = session('me')

// followSession binds the stores of the first join: one Pinia for the file.
let auth: any
let voice: any

beforeAll(async () => {
  setActivePinia(createPinia())
  auth = useAuthStore()
  voice = useUnifiedVoiceChannelStore()
  auth.cleanupNotificationSystem = vi.fn()
  auth.clearAccountState = vi.fn(async () => {})
  auth.setUserOffline = vi.fn(async () => {})
  auth.initializeUserSettings = vi.fn()
  await auth.initializeAuth()
})

beforeEach(() => {
  auth.isPasswordResetMode = false
  auth._pendingMFAVerification = false
  auth.session = null
  voice.resetState()
  voice.optimisticChannelId = null
  auth.session = ME
  auth$.stored = null
  auth$.signOut.mockReset().mockResolvedValue(undefined)
  for (const fn of [webrtc.leaveChannel, dm.cleanup, dm.leaveCall, serverUsers.leaveVoiceChannel, push, db.rpc, db.from,
    auth.clearAccountState, auth.cleanupNotificationSystem]) fn.mockClear()
  voice.followSession()
})

function inCall(room: { server: string; channel: string } = { server: 's1', channel: 'c1' }) {
  voice.$patch({ isConnected: true, currentServerId: room.server, currentChannelId: room.channel, isOverlayVisible: true, connectionMode: 'p2p' })
}

/** The call is closed here, its UI state gone, with nothing sent in the account's name. */
function expectClosedSilently() {
  expect(webrtc.leaveChannel.mock.calls).toEqual([[{ silent: true }]])
  expect(dm.cleanup).toHaveBeenCalled()
  expect(voice.isConnectedOrJoining).toBe(false)
  expect(voice.currentChannelId).toBeNull()
  expect(voice.isOverlayVisible).toBe(false)
  expect(dm.leaveCall).not.toHaveBeenCalled()
  expect(dm.endFederatedCall).not.toHaveBeenCalled()
  expect(serverUsers.leaveVoiceChannel).not.toHaveBeenCalled()
  expect(db.rpc).not.toHaveBeenCalled()
  expect(db.from).not.toHaveBeenCalled()
}

function expectSignIn(to: unknown = '/login') {
  expect(push).toHaveBeenCalledTimes(1)
  expect(push).toHaveBeenCalledWith(to)
  expect(auth.clearAccountState).toHaveBeenCalledTimes(1)
}

describe('the session ends outside this tab\'s sign-out', () => {
  it.each([
    ['a voice channel', { server: 's1', channel: 'c1' }],
    ['a DM call', { server: 'dm', channel: 'dm-conv' }],
    ['a federated DM call', { server: 'dm', channel: 'federated-dm-conv-1' }],
  ])('signed out in another tab, or a refused refresh (SIGNED_OUT), in %s', async (_what, room) => {
    inCall(room)
    await auth$.event('SIGNED_OUT', null)
    expectClosedSilently()
    expect(auth.session).toBeNull()
    expectSignIn()
  })

  it('the microphone closes before anything is awaited', () => {
    inCall()
    void auth$.event('SIGNED_OUT', null)
    expect(webrtc.leaveChannel).toHaveBeenCalledWith({ silent: true })
  })

  it.each(['session_revoked', 'insufficient_aal'] as const)('refused by PostgREST as %s, before GoTrue answers the sign-out', async (reason) => {
    inCall()
    let answer!: () => void
    auth$.signOut.mockReturnValue(new Promise<void>((resolve) => { answer = resolve }))
    auth$.rejected(reason)
    expectClosedSilently()
    expect(push).not.toHaveBeenCalled()
    answer()
    await vi.waitFor(() => expectSignIn({ path: '/login', query: { reason } }))
  })

  it('a refused session says SIGNED_OUT too: one return to sign-in, with its reason', async () => {
    inCall()
    auth$.signOut.mockImplementation(async () => { await auth$.event('SIGNED_OUT', null) })
    auth$.rejected('session_revoked')
    await vi.waitFor(() => expectSignIn({ path: '/login', query: { reason: 'session_revoked' } }))
    expectClosedSilently()
  })

  it('the stored session removed by another tab, without a SIGNED_OUT', async () => {
    inCall()
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'sb-test-auth-token', newValue: null }))
    await vi.waitFor(() => expectSignIn())
    expectClosedSilently()
  })

  it('a stored session replaced, or another key, ends nothing', async () => {
    inCall()
    auth$.stored = ME
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'sb-test-auth-token', newValue: null }))
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'other', newValue: null }))
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'sb-test-auth-token', newValue: '{}' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(auth.session).not.toBeNull()
    expect(webrtc.leaveChannel).not.toHaveBeenCalled()
  })

  it('another account\'s unfinished sign-in (aal1 with a factor)', async () => {
    inCall()
    await auth$.event('SIGNED_IN', session('other', 'aal1'))
    expectClosedSilently()
    expect(auth.session).toBeNull()
    expectSignIn()
  })

  it('a join in progress is cancelled', async () => {
    const controller = new AbortController()
    voice.$patch({ optimisticChannelId: 'c1', optimisticServerId: 's1', isConnecting: true })
    voice.connectionAbortController = controller
    await auth$.event('SIGNED_OUT', null)
    expect(controller.signal.aborted).toBe(true)
    expectClosedSilently()
    expectSignIn()
  })

  it('out of a call, returns to sign-in all the same', async () => {
    await auth$.event('SIGNED_OUT', null)
    expectSignIn()
  })
})

describe('another account takes this page', () => {
  it.each([
    ['signed in in another tab', 'SIGNED_IN', session('other')],
    ['a refreshed token of it', 'TOKEN_REFRESHED', session('other')],
    ['a password recovery of it', 'PASSWORD_RECOVERY', session('other')],
  ] as const)('%s: the call of the first one ends', async (_what, event, next) => {
    inCall()
    await auth$.event(event, next)
    expectClosedSilently()
    expect(auth.session.user.id).toBe('other')
    expect(push).not.toHaveBeenCalledWith('/login')
  })

  it('the same account\'s refreshed token leaves the call alone', async () => {
    inCall()
    await auth$.event('TOKEN_REFRESHED', session('me'))
    auth.session = session('me')
    expect(webrtc.leaveChannel).not.toHaveBeenCalled()
    expect(voice.isConnected).toBe(true)
  })
})

describe('recovery', () => {
  it('its own sign-out stays on its page', async () => {
    auth.isPasswordResetMode = true
    await auth$.event('SIGNED_OUT', null)
    expect(push).not.toHaveBeenCalled()
  })
})

describe('sign-out in this tab', () => {
  it('leaves the call with the session, announced, then signs out and returns to sign-in once', async () => {
    inCall()
    const at: Array<string> = []
    webrtc.leaveChannel.mockImplementation(async (opts) => { at.push(`${opts?.silent ? 'silent' : 'announced'} ${auth.session ? 'session' : 'none'}`) })
    auth$.signOut.mockImplementation(async () => { at.push('signed out'); await auth$.event('SIGNED_OUT', null) })
    await auth.logout()
    expect(at[0]).toBe('announced session')
    expect(at.indexOf('signed out')).toBeGreaterThan(0)
    expect(serverUsers.leaveVoiceChannel).toHaveBeenCalledWith('s1', 'c1', 'me', true)
    expectSignIn()
    webrtc.leaveChannel.mockReset().mockResolvedValue(undefined)
  })

  it('a leave that hangs past 3 s: the end of the session closes the transport', async () => {
    vi.useFakeTimers()
    try {
      inCall()
      webrtc.leaveChannel.mockImplementation((opts) => (opts?.silent ? Promise.resolve(undefined) : new Promise(() => {})))
      const done = auth.logout()
      await vi.advanceTimersByTimeAsync(2_900)
      expect(webrtc.leaveChannel).not.toHaveBeenCalledWith({ silent: true })
      await vi.advanceTimersByTimeAsync(200)
      expect(webrtc.leaveChannel).toHaveBeenLastCalledWith({ silent: true })
      await done
      expectSignIn()
    } finally {
      vi.useRealTimers()
      webrtc.leaveChannel.mockReset().mockResolvedValue(undefined)
    }
  })
})
