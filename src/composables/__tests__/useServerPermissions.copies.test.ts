// A copy of a server hosted on another instance grants no server authority here, whatever its
// owner column or a stale permission answer says (migration 20261027200001).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import type { Server } from '@/types'

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: true, profileId: 'me' }),
  },
}))

vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getCurrentUser: ref({ id: 'me' }), unsubscribeFromContext: vi.fn() }),
}))

vi.mock('@/utils/debug', () => ({
  debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-router', async (orig) => ({
  ...(await orig<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('vue-i18n', async (orig) => ({
  ...(await orig<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => ({}) }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => ({}) }))
vi.mock('@/services/federation/FederationServerService', () => ({ federationServerService: {} }))

vi.mock('@/services/RoleService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/RoleService')>()
  const P = actual.Permission
  // Every moderation bit, as a stale or forged answer would claim.
  const all = {
    [P.MANAGE_SERVER]: true, [P.MANAGE_CHANNELS]: true, [P.MANAGE_ROLES]: true, [P.MANAGE_MESSAGES]: true,
    [P.PIN_MESSAGES]: true, [P.KICK_MEMBERS]: true, [P.BAN_MEMBERS]: true, [P.TIMEOUT_MEMBERS]: true,
    [P.CREATE_PUBLIC_THREADS]: true,
  }
  return {
    ...actual,
    roleService: {
      getUserPermissions: vi.fn(async () => all),
      getUserRoles: vi.fn(async () => []),
      hasPermission: vi.fn(async () => true),
    },
  }
})

const { useServerPermissions } = await import('../useServerPermissions')
const { useLeaveServer } = await import('../useLeaveServer')

const server = (id: string, local: boolean): Server =>
  ({ id, owner: 'me', name: id, is_local_server: local, federation_domain: local ? undefined : 'host.test' }) as unknown as Server

describe('useServerPermissions on a copy', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useServerChannelStore()
    store.servers = [server('copy', false), server('home', true)]
    store.currentServer = store.servers[0]
    useAuthStore().session = { user: { id: 'me' } } as any
  })

  const run = <T>(fn: () => T): T => effectScope().run(fn)!

  it('is not owned by the local profile its row names', () => {
    const { isCurrentUserServerOwner, isServerOwner } = run(() => useServerPermissions())
    expect(isCurrentUserServerOwner.value).toBe(false)
    expect(isServerOwner('copy', 'me')).toBe(false)
    expect(isServerOwner('home', 'me')).toBe(true)
  })

  it('offers no settings, roles, bans, reports, delete, pins, moderation or channel moves', async () => {
    const p = run(() => useServerPermissions())
    await flushPromises()
    expect(p.serverSettingsPermissions.value).toMatchObject({
      canEditBasicInfo: false,
      canDeleteServer: false,
      canManageRoles: false,
      canModerateReports: false,
      canManageBans: false,
      canViewAuditLog: false,
      canUploadEmojis: false,
    })
    expect(p.canManageMessages.value).toBe(false)
    expect(p.canPinMessages.value).toBe(false)
    expect(p.canModerateMembers.value).toBe(false)
    expect(p.canPerformDestructiveActions.value).toBe(false)
    expect(p.channelPermissions.value.canReorderChannels).toBe(false)
    expect(p.isLocalServer.value).toBe(false)
  })

  it('keeps what a member does in it', async () => {
    const p = run(() => useServerPermissions())
    await flushPromises()
    expect(p.canCreateThreads.value).toBe(true)
  })

  it('keeps the owner\'s authority on a server hosted here', async () => {
    const p = run(() => useServerPermissions(() => 'home'))
    await flushPromises()
    expect(p.serverSettingsPermissions.value.canDeleteServer).toBe(true)
    expect(p.serverSettingsPermissions.value.canManageBans).toBe(true)
  })

  it('lets its named owner leave it', () => {
    const { isOwner } = run(() => useLeaveServer())
    expect(isOwner(server('copy', false))).toBe(false)
    expect(isOwner(server('home', true))).toBe(true)
  })
})
