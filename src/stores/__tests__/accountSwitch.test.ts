import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Another account's session reaches this tab without a sign-out here: signed in in another tab, a
// refreshed token, an MFA verify or a password recovery of it. The first account's state goes before
// the second one's session is set, and the page stays where it is.

const at = vi.hoisted(() => [] as string[])
const auth$ = vi.hoisted(() => ({ listener: null as unknown as (event: string, session: unknown) => unknown, factors: [] as unknown[] }))
const push = vi.hoisted(() => vi.fn(async (_to: unknown) => undefined))
const signOut = vi.hoisted(() => vi.fn(async () => {}))
const step = vi.hoisted(() => (name: string) => () => { at.push(name) })

vi.mock('@/supabase', () => ({
  onSessionRejected: () => () => {},
  signOutAndForget: signOut,
  signOutEverywhere: async () => {},
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    from: () => {
      const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) }
      return chain
    },
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword: async ({ email }: { email: string }) => {
        const session = { access_token: 'h.e30.s', user: { id: email } }
        return { data: { user: session.user, session }, error: null }
      },
      onAuthStateChange: (listener: typeof auth$.listener) => {
        auth$.listener = listener
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      mfa: { listFactors: async () => ({ data: { totp: auth$.factors }, error: null }) },
    },
  },
}))
vi.mock('@/router', () => ({ default: { push } }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { clearCache: step('auth context') } }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: { cleanup: step('calls') } }))
vi.mock('@/services/GlobalDMCallListener', () => ({ globalDMCallListener: { cleanup: () => {} } }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ clearProfile: step('profile'), fetchProfileByAuthUserId: async () => {} }) }))
vi.mock('@/composables/useVisualTheme', () => ({ useVisualTheme: () => ({ initialize: async () => {}, reset: () => {} }) }))
vi.mock('@/stores/useFunding', () => ({ useFundingStore: () => ({ load: async () => {}, clear: () => {} }) }))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({
    initialize: async () => { at.push('timelines of the next account') },
    cleanupRealtimeSubscriptions: () => {}, clearTimelineCache: step('timelines'), resetUserRelationshipState: () => {},
  }),
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({
  useUnifiedVoiceChannelStore: () => ({ isConnected: false, clearVoiceChannelState: () => {}, stopVoiceSessionHeartbeat: () => {} }),
}))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ $dispose: () => {} }) }))
vi.mock('@/stores/postReactions', () => ({ usePostReactionsStore: () => ({ $dispose: () => {} }) }))
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ cleanupBroadcastHandlers: () => {}, resetForLogout: step('notifications') }),
}))
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => ({ cleanupRealtimeSubscriptions: () => {} }) }))
vi.mock('@/stores/useChat', () => ({
  useChatStore: () => ({ unsubscribeFromMessages: () => {}, clearAllCaches: step('messages'), replyMessageCache: new Map(), $reset: () => {} }),
}))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => ({ cleanup: step('conversations') }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ cleanupSubscriptions: async () => {}, $reset: step('servers') }) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ cleanup: step('members') }) }))
vi.mock('@/stores/useServerWelcome', () => ({ useServerWelcomeStore: () => ({ reset: () => {} }) }))
vi.mock('@/composables/usePushNotifications', () => ({ usePushNotifications: () => ({ resetState: () => {} }) }))
vi.mock('@/services/StatePersistence', () => ({ statePersistence: { cleanup: async () => {} } }))
vi.mock('@/composables/useServerPermissions', () => ({ clearAllPermissionCaches: step('permissions') }))
vi.mock('@/stores/useOutbox', () => ({ useOutboxStore: () => ({ reset: step('outbox') }) }))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { disconnect: step('user channel') } }))
vi.mock('@/services/ViewContextTracker', () => ({ viewContextTracker: { reset: () => {} } }))
vi.mock('@/services/ServiceWorkerManager', () => ({ forgetQuickReplies: step('quick replies') }))
vi.mock('@/services/ChannelEncryptionService', () => ({ forgetChannelEncryption: () => {} }))
vi.mock('@/services/conversationEncryption', () => ({ forgetConversationEncryption: () => {} }))
vi.mock('@/services/privateMedia', () => ({ forgetSignedMediaUrls: step('signed media') }))
vi.mock('@/services/uploads/storageUpload', () => ({ forgetResumableUploads: () => {} }))
vi.mock('@/services/transfers', () => ({ resetTransfers: () => {} }))
vi.mock('@/utils/remoteServerSync', () => ({ resetRemoteServerSync: () => {} }))
vi.mock('@/services/botCommandService', () => ({ clearBotCommandCache: () => {} }))
vi.mock('@/stores/useBotInteractions', () => ({ useBotInteractionsStore: () => ({ reset: () => {} }) }))
vi.mock('@/stores/playTogether', () => ({ usePlayTogetherStore: () => ({ reset: step('games') }) }))
vi.mock('@/stores/activities', () => ({ useActivitiesStore: () => ({ reset: step('watch together') }) }))
vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: { lockEncryption: async () => { at.push('encryption') } },
}))
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getItem: () => null, setItem: () => {}, removeItem: () => {}, getCurrentUser: () => null,
    setCurrentUser: (id: string) => { at.push(`storage of ${id}`) }, clearCurrentUser: () => { at.push('storage of no one') },
  },
}))

import { useAuthStore } from '@/stores/auth'

const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`
const session = (id: string, aal = 'aal2') => ({ access_token: jwt({ aal, sub: id, amr: [{ method: 'password' }] }), user: { id } }) as any
const ACCOUNT_STATE = ['auth context', 'calls', 'profile', 'timelines', 'notifications', 'messages', 'conversations', 'servers', 'members',
  'permissions', 'outbox', 'user channel', 'quick replies', 'signed media', 'games', 'watch together', 'encryption']

let auth: any

/** Fires an event and waits for the store to handle it. */
async function fire(event: string, next: unknown) {
  let handled: Promise<void> | null = null
  const stop = auth.$onAction(({ name, after, onError }: any) => {
    if (name === 'handleAuthEvent') handled = new Promise((resolve) => { after(() => resolve()); onError(() => resolve()) })
  })
  auth$.listener(event, next)
  stop()
  await handled
}

beforeEach(async () => {
  setActivePinia(createPinia())
  auth = useAuthStore()
  auth.setUserOffline = vi.fn(async () => {})
  await auth.initializeAuth()
  auth.session = session('alice')
  auth.$subscribe((_m: unknown, state: any) => { at.push(`session ${state.session?.user?.id ?? 'none'}`) }, { flush: 'sync' })
  auth$.factors = []
  push.mockClear()
  signOut.mockClear()
  at.length = 0
})

describe('another account\'s session in this tab', () => {
  it.each([
    ['signed in in another tab', 'SIGNED_IN', session('bob', 'aal1')],
    ['a refreshed token of it', 'TOKEN_REFRESHED', session('bob', 'aal1')],
    ['its MFA verify in another tab', 'MFA_CHALLENGE_VERIFIED', session('bob')],
    ['its password recovery', 'PASSWORD_RECOVERY', session('bob', 'aal1')],
  ])('%s: everything of the first account goes before the session is set', async (_what, event, next) => {
    await fire(event, next)
    expect(auth.session.user.id).toBe('bob')
    const adopted = at.lastIndexOf('session bob')
    expect(at.indexOf('session none')).toBeGreaterThanOrEqual(0)
    for (const state of ACCOUNT_STATE) {
      expect(at.indexOf(state), state).toBeGreaterThan(at.indexOf('session none'))
      expect(at.indexOf(state), state).toBeLessThan(adopted)
    }
    expect(push).not.toHaveBeenCalledWith('/login')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('is set up as a sign-in is, whichever event brought it', async () => {
    await fire('TOKEN_REFRESHED', session('bob', 'aal1'))
    expect(at).toContain('storage of bob')
    expect(at).toContain('timelines of the next account')
  })

  it('a recovery opens the reset page, and no sign-in of it is set up', async () => {
    await fire('PASSWORD_RECOVERY', session('bob', 'aal1'))
    expect(push).toHaveBeenCalledExactlyOnceWith('/reset-password')
    expect(auth.isLoggedIn).toBe(false)
    expect(at).not.toContain('storage of bob')
  })

  it('an unfinished sign-in (aal1 with a factor) is not adopted by its refreshed token either', async () => {
    auth$.factors = [{ status: 'verified' }]
    await fire('TOKEN_REFRESHED', session('bob', 'aal1'))
    expect(auth.session).toBeNull()
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledExactlyOnceWith('/login')
    expect(at).not.toContain('session bob')
  })

  it('signed out while the first account is being cleared: neither is left in, and sign-in is shown', async () => {
    let cleared!: () => void
    auth.clearAccountState = vi.fn(() => new Promise<void>((resolve) => { cleared = resolve }))
    const adopting = fire('SIGNED_IN', session('bob', 'aal1'))
    await vi.waitFor(() => expect(auth.clearAccountState).toHaveBeenCalled())
    await fire('SIGNED_OUT', null)
    auth.clearAccountState.mockResolvedValue(undefined)
    cleared()
    await adopting
    expect(auth.session).toBeNull()
    expect(at).not.toContain('session bob')
    expect(push).toHaveBeenCalledWith('/login')
  })

  it('a third account\'s sign-in has the last word', async () => {
    const adopting = fire('SIGNED_IN', session('bob', 'aal1'))
    await fire('SIGNED_IN', session('carol', 'aal1'))
    await adopting
    expect(auth.session.user.id).toBe('carol')
    expect(at).not.toContain('session bob')
  })

  it('typed into this tab\'s sign-in form, it clears the account the tab picked up meanwhile', async () => {
    await auth.login('bob', 'secret')
    expect(auth.session.user.id).toBe('bob')
    expect(at.indexOf('servers')).toBeGreaterThanOrEqual(0)
    expect(at.indexOf('servers')).toBeLessThan(at.lastIndexOf('session bob'))
  })
})

describe('the account already in this tab', () => {
  it.each(['SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION'])('%s of it clears nothing', async (event) => {
    await fire(event, session('alice'))
    expect(at).toEqual([])
    expect(auth.session.user.id).toBe('alice')
  })
})

describe('sign-in again after a sign-out', () => {
  it('waits for the first account\'s state to be gone', async () => {
    let cleared!: () => void
    auth.clearAccountState = vi.fn(() => new Promise<void>((resolve) => { cleared = () => { at.push('cleared'); resolve() } }))
    const leaving = fire('SIGNED_OUT', null)
    await vi.waitFor(() => expect(auth.clearAccountState).toHaveBeenCalled())
    const signIn = auth.login('bob', 'secret')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(auth.session).toBeNull()
    cleared()
    await Promise.all([leaving, signIn])
    expect(at.indexOf('cleared')).toBeLessThan(at.indexOf('session bob'))
  })

  it('returns to sign-in before the stores reset', async () => {
    push.mockImplementationOnce(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); at.push('navigated'); return undefined })
    await fire('SIGNED_OUT', null)
    expect(at.indexOf('navigated')).toBeGreaterThanOrEqual(0)
    expect(at.indexOf('navigated')).toBeLessThan(at.indexOf('servers'))
  })

  it('a navigation that hangs holds the reset 2 s at most', async () => {
    vi.useFakeTimers()
    try {
      push.mockImplementationOnce(() => new Promise(() => {}))
      const leaving = fire('SIGNED_OUT', null)
      await vi.advanceTimersByTimeAsync(1_900)
      expect(at).not.toContain('servers')
      await vi.advanceTimersByTimeAsync(200)
      await vi.waitFor(() => expect(at).toContain('servers'))
      await leaving
    } finally {
      vi.useRealTimers()
    }
  })
})
