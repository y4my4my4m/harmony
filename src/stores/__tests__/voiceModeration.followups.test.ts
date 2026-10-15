import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// 20261017100005_voice_moderation_followups.sql on the client:
//   - Mute, Deafen and Move Members decide the menu alone, as in Discord: the owner, a higher
//     role and oneself are offered them; kick and ban keep role order;
//   - a move relayed by a remote server's Group is joined through that server's host;
//   - a voice-grants broadcast makes a P2P client re-read SPEAK and STREAM and leave a channel
//     that no longer admits it; on LiveKit the server acts.

const voice = vi.hoisted(() => ({
  isConnected: true,
  currentServerId: 's' as string | null,
  currentChannelId: 'lounge' as string | null,
  optimisticChannelId: null,
  optimisticServerId: null,
  isFederatedChannel: false,
  connectionMode: 'p2p' as string,
  localState: { userId: 'me' },
  joinVoiceChannel: vi.fn(async () => true),
  leaveVoiceChannel: vi.fn(async () => true),
  loadChannelGrants: vi.fn(async () => undefined),
}))
const perms = vi.hoisted(() => ({ inChannel: {} as Record<string, boolean>, serverWide: {} as Record<string, boolean> }))
const roles = vi.hoisted(() => ({ byUser: {} as Record<string, Array<{ position: number }>> }))
const roleService = vi.hoisted(() => ({
  getUserPermissions: vi.fn(async (_me: string, _server: string, channel?: string) => (channel ? perms.inChannel : perms.serverWide)),
  getUserRoles: vi.fn(async (user: string) => roles.byUser[user] ?? []),
  clearServerCache: vi.fn(),
}))
const api = vi.hoisted(() => ({ mayConnectVoice: vi.fn(async () => true) }))
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }))

vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({
    channels: [{ id: 'annex', name: 'annex', type: 1 }],
    servers: [{ id: 's', owner: 'owner', is_local_server: true }],
    currentServer: null,
  }),
}))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ usersInVoiceChannels: {} }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => toasts }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: async () => 'me' } }))
vi.mock('@/services/RoleService', () => ({ roleService }))
vi.mock('@/services/voice/voiceModerationApi', () => api)
vi.mock('@/composables/useAnnouncer', () => ({ announce: vi.fn() }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/supabase', () => ({ supabase: { realtime: { isConnected: () => true } } }))

const { useVoiceModerationStore } = await import('@/stores/voiceModeration')

beforeEach(() => {
  setActivePinia(createPinia())
  Object.assign(voice, {
    isConnected: true, currentServerId: 's', currentChannelId: 'lounge', isFederatedChannel: false, connectionMode: 'p2p',
  })
  perms.inChannel = { MUTE_MEMBERS: true, DEAFEN_MEMBERS: true, MOVE_MEMBERS: true }
  perms.serverWide = { KICK_MEMBERS: true, BAN_MEMBERS: true }
  roles.byUser = { me: [{ position: 1 }], boss: [{ position: 9 }], low: [{ position: 0 }] }
  api.mayConnectVoice.mockResolvedValue(true)
  for (const fn of [voice.joinVoiceChannel, voice.leaveVoiceChannel, voice.loadChannelGrants, roleService.clearServerCache, api.mayConnectVoice, toasts.showToast]) {
    fn.mockClear()
  }
})

describe('capabilities', () => {
  const voiceOnly = { mute: true, deafen: true, move: true, kick: false, ban: false }

  it('a member ranked above the caller: voice moderation, not kick or ban', async () => {
    expect(await useVoiceModerationStore().capabilities('s', 'lounge', 'boss')).toEqual(voiceOnly)
  })

  it('the owner and oneself: voice moderation, never kick or ban', async () => {
    const moderation = useVoiceModerationStore()
    expect(await moderation.capabilities('s', 'lounge', 'owner')).toEqual(voiceOnly)
    expect(await moderation.capabilities('s', 'lounge', 'me')).toEqual(voiceOnly)
  })

  it('a member ranked below: everything the permissions give', async () => {
    expect(await useVoiceModerationStore().capabilities('s', 'lounge', 'low'))
      .toEqual({ mute: true, deafen: true, move: true, kick: true, ban: true })
  })

  it('without the permissions: nothing, whatever the ranks', async () => {
    perms.inChannel = {}
    perms.serverWide = {}
    expect(await useVoiceModerationStore().capabilities('s', 'lounge', 'low'))
      .toEqual({ mute: false, deafen: false, move: false, kick: false, ban: false })
  })
})

describe('departures', () => {
  it('a move in a remote server\'s call is joined through its host', async () => {
    voice.isFederatedChannel = true
    await useVoiceModerationStore().followDeparture('s', 'lounge', 'annex', 'moved')
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith('annex', 's', { federated: true })
  })

  it('a move in a local call stays local', async () => {
    await useVoiceModerationStore().followDeparture('s', 'lounge', 'annex', 'moved')
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith('annex', 's', { local: true })
  })

  it('lost access says so', async () => {
    await useVoiceModerationStore().followDeparture('s', 'lounge', null, 'revoked')
    expect(voice.leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(toasts.showToast).toHaveBeenCalledWith('server_update', 'voice.moderation.youWereDisconnectedTitle', 'voice.moderation.youLostAccess', 6000)
  })

  it('a membership end on a remote server names no channel and still ends its call', async () => {
    voice.isFederatedChannel = true
    await useVoiceModerationStore().followDeparture('s', null, null, 'removed')
    expect(voice.leaveVoiceChannel).toHaveBeenCalledTimes(1)
  })
})

describe('recheckGrants', () => {
  it('a P2P client in scope re-reads its grants with a fresh permission cache', async () => {
    await useVoiceModerationStore().recheckGrants('s', null, null)
    expect(roleService.clearServerCache).toHaveBeenCalledWith('s')
    expect(api.mayConnectVoice).toHaveBeenCalledWith('lounge')
    expect(voice.loadChannelGrants).toHaveBeenCalledWith('s', 'lounge', 'me')
    expect(voice.leaveVoiceChannel).not.toHaveBeenCalled()
  })

  it('and leaves a channel that no longer admits it', async () => {
    api.mayConnectVoice.mockResolvedValue(false)
    await useVoiceModerationStore().recheckGrants('s', 'lounge', null)
    expect(voice.leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(voice.loadChannelGrants).not.toHaveBeenCalled()
  })

  it('ignores another channel, another member, another server and a remote server\'s call', async () => {
    const moderation = useVoiceModerationStore()
    await moderation.recheckGrants('s', 'annex', null)
    await moderation.recheckGrants('s', null, 'someone')
    await moderation.recheckGrants('other', null, null)
    voice.isFederatedChannel = true
    await moderation.recheckGrants('s', null, null)
    expect(api.mayConnectVoice).not.toHaveBeenCalled()
  })

  it('on LiveKit leaves the decision to the server', async () => {
    voice.connectionMode = 'livekit'
    await useVoiceModerationStore().recheckGrants('s', null, 'me')
    expect(roleService.clearServerCache).toHaveBeenCalledWith('s')
    expect(api.mayConnectVoice).not.toHaveBeenCalled()
  })
})
