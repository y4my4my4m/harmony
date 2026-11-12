/**
 * Settings > Server profiles, "Sync from Discord": every field is ticked until a choice is saved,
 * toggling saves nothing, and Save and sync saves the ticked fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const { query, myLink, setMySync } = vi.hoisted(() => ({
  query: { server: 'A' as string | undefined },
  myLink: vi.fn(),
  setMySync: vi.fn(async () => {}),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => ({ query }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ hasPermissionAsync: async () => true }),
}))
vi.mock('@/services/serverProfileService', () => ({
  setMyServerProfile: vi.fn(async () => ({})),
  loadMyServerProfile: vi.fn(async () => {}),
}))
vi.mock('@/services/discordMigrationService', () => ({ myLink, setMySync }))
vi.mock('@/services/ProfileService', () => ({
  profileService: { uploadServerAvatar: vi.fn(), uploadServerBanner: vi.fn() },
}))
vi.mock('@/supabase', () => ({
  SUPABASE_URL: 'http://db.test',
  SUPABASE_ANON_KEY: 'anon',
  supabase: {
    from: () => {
      const q: any = { select: () => q, eq: () => q, in: () => q, single: async () => ({ data: null }), then: (r: any) => r({ data: [], error: null }) }
      return q
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: () => {
      const ch: any = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: vi.fn(async () => 'ok'),
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

import { userDataService } from '@/services/userDataService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import ServerProfilesSettings from '../ServerProfilesSettings.vue'

const ME = '11111111-1111-4111-8111-111111111111'

describe('ServerProfilesSettings: Sync from Discord', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    myLink.mockReset()
    setMySync.mockReset()
    setMySync.mockResolvedValue(undefined)
    ;(userDataService as any).users.clear()
    ;(userDataService as any).memberServerFields.clear()
    ;(userDataService as any).currentUserId = ME
    ;(userDataService as any).users.set(ME, {
      id: ME, username: 'me_acct', displayName: 'Account Name', avatarUrl: 'a.png', bio: '',
      status: 0, isOnline: false, isMobile: false, createdAt: '', lastSeen: '', lastHeartbeat: '',
      isLocal: true, lastCacheUpdate: '', source: 'database',
    })
    useServerChannelStore().servers = [{ id: 'A', name: 'Alpha', is_local_server: true }] as any
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  const mountTab = async () => {
    wrapper = mount(ServerProfilesSettings, { attachTo: document.body, global: { stubs: { UnifiedProfileCard: true } } })
    await flushPromises()
    return wrapper
  }
  const checked = (w: VueWrapper, field: string) => (w.get(`[data-testid="sync-${field}"]`).element as HTMLInputElement).checked

  it('ticks every field when no choice was saved', async () => {
    myLink.mockResolvedValue({ status: 'active', syncFields: [], syncChosen: false, discordJoinedAt: null })
    const w = await mountTab()
    expect(checked(w, 'avatar')).toBe(true)
    expect(checked(w, 'server_banner')).toBe(true)
  })

  it('shows the saved choice as it is', async () => {
    myLink.mockResolvedValue({ status: 'active', syncFields: ['banner'], syncChosen: true, discordJoinedAt: null })
    const w = await mountTab()
    expect(checked(w, 'banner')).toBe(true)
    expect(checked(w, 'avatar')).toBe(false)
  })

  it('saves nothing on a toggle and saves the ticked fields on Save and sync', async () => {
    myLink.mockResolvedValue({ status: 'active', syncFields: ['banner'], syncChosen: true, discordJoinedAt: null })
    const w = await mountTab()
    await w.get('[data-testid="sync-avatar"]').setValue(true)
    expect(setMySync).not.toHaveBeenCalled()
    await w.get('[data-testid="discord-sync-save"]').trigger('click')
    await flushPromises()
    expect(setMySync).toHaveBeenCalledWith('A', ['avatar', 'banner'])
    expect(w.get('[data-testid="discord-sync-done"]').exists()).toBe(true)
  })

  it('reports a failed save', async () => {
    myLink.mockResolvedValue({ status: 'active', syncFields: [], syncChosen: true, discordJoinedAt: null })
    setMySync.mockRejectedValueOnce(new Error('x'))
    const w = await mountTab()
    await w.get('[data-testid="discord-sync-save"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="discord-sync-error"]').exists()).toBe(true)
  })
})
