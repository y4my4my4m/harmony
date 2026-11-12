/**
 * Settings > Server profiles: the picker preselects from ?server=, saving sends only the
 * changed keys, Reset sends null, a member without CHANGE_NICKNAME is locked, and a server
 * hosted on another instance is listed but disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const { toast, query, setMy, loadMy, canChange, permCheck } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  query: { server: undefined as string | undefined },
  setMy: vi.fn(async () => ({})),
  loadMy: vi.fn(async () => {}),
  canChange: { value: true },
  permCheck: { gate: null as Promise<void> | null },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => ({ query }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    hasPermissionAsync: async () => {
      if (permCheck.gate) await permCheck.gate
      return canChange.value
    },
  }),
}))
vi.mock('@/services/serverProfileService', () => ({
  setMyServerProfile: setMy,
  loadMyServerProfile: loadMy,
}))
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

describe('ServerProfilesSettings', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    setMy.mockClear()
    toast.error.mockClear()
    canChange.value = true
    permCheck.gate = null
    query.server = undefined
    ;(userDataService as any).users.clear()
    ;(userDataService as any).memberServerFields.clear()
    ;(userDataService as any).currentUserId = ME
    ;(userDataService as any).users.set(ME, {
      id: ME, username: 'me_acct', displayName: 'Account Name', avatarUrl: 'a.png', bio: 'Account bio',
      status: 0, isOnline: false, isMobile: false, createdAt: '', lastSeen: '', lastHeartbeat: '',
      isLocal: true, lastCacheUpdate: '', source: 'database',
    })
    useServerChannelStore().servers = [
      { id: 'A', name: 'Alpha', is_local_server: true },
      { id: 'B', name: 'Beta', is_local_server: true },
      { id: 'R', name: 'Remote', is_local_server: false },
    ] as any
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

  it('preselects the server from the query', async () => {
    query.server = 'B'
    const w = await mountTab()
    expect((w.get('[data-testid="server-picker"]').element as HTMLSelectElement).value).toBe('B')
  })

  it('lists a server hosted elsewhere as disabled', async () => {
    const w = await mountTab()
    const remote = w.findAll('option').find(o => o.attributes('value') === 'R')!
    expect(remote.attributes('disabled')).toBeDefined()
    expect(remote.text()).toContain('serverProfile.remoteUnavailable')
  })

  it('does not preselect a remote server', async () => {
    query.server = 'R'
    const w = await mountTab()
    expect((w.get('[data-testid="server-picker"]').element as HTMLSelectElement).value).toBe('A')
  })

  it('saves only the changed keys and updates the cache', async () => {
    query.server = 'A'
    userDataService.setMemberServerProfile('A', ME, { nickname: 'Old', pronouns: 'they/them' })
    const w = await mountTab()
    await w.get('[data-testid="field-nickname"]').setValue('  New  ')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(setMy).toHaveBeenCalledTimes(1)
    expect(setMy).toHaveBeenCalledWith('A', { nickname: 'New' })
    expect(userDataService.getMemberServerFields('A', ME)).toMatchObject({ nickname: 'New', pronouns: 'they/them' })
  })

  it('clears a field to null on save when emptied', async () => {
    query.server = 'A'
    userDataService.setMemberServerProfile('A', ME, { bio: 'hello' })
    const w = await mountTab()
    await w.get('[data-testid="field-bio"]').setValue('')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(setMy).toHaveBeenCalledWith('A', { bio: null })
  })

  it('Reset sends the field as null', async () => {
    query.server = 'A'
    userDataService.setMemberServerProfile('A', ME, { pronouns: 'they/them' })
    const w = await mountTab()
    await w.get('[data-testid="reset-pronouns"]').trigger('click')
    await flushPromises()
    expect(setMy).toHaveBeenCalledWith('A', { pronouns: null })
    expect(userDataService.getMemberServerFields('A', ME)?.pronouns).toBeNull()
  })

  it('locked_tab: without CHANGE_NICKNAME the inputs and Reset are disabled', async () => {
    canChange.value = false
    query.server = 'A'
    userDataService.setMemberServerProfile('A', ME, { nickname: 'Kept', pronouns: 'x', bio: 'y', avatar_url: 'a', banner_url: 'b' })
    const w = await mountTab()
    expect(w.get('[data-testid="server-profile-locked"]').text()).toBe('serverProfile.locked')
    for (const id of ['field-nickname', 'field-pronouns', 'field-bio', 'field-avatar', 'field-banner',
      'reset-nickname', 'reset-pronouns', 'reset-bio', 'reset-avatar_url', 'reset-banner_url', 'save-server-profile']) {
      expect(w.get(`[data-testid="${id}"]`).attributes('disabled'), id).toBeDefined()
    }
    // Stored values still display.
    expect((w.get('[data-testid="field-nickname"]').element as HTMLInputElement).value).toBe('Kept')
  })

  it('shows a skeleton, not the locked note or disabled inputs, while the permission is pending', async () => {
    query.server = 'A'
    let release!: () => void
    permCheck.gate = new Promise<void>(r => { release = r })
    const w = await mountTab()
    expect(w.get('[data-testid="server-profile-loading"]').attributes('aria-busy')).toBe('true')
    expect(w.find('[data-testid="server-profile-locked"]').exists()).toBe(false)
    expect(w.find('[data-testid="field-nickname"]').exists()).toBe(false)
    release()
    await flushPromises()
    expect(w.find('[data-testid="server-profile-loading"]').exists()).toBe(false)
    expect(w.get('[data-testid="field-nickname"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-testid="server-profile-locked"]').exists()).toBe(false)
  })

  it('shows the locked state once the pending permission resolves denied', async () => {
    query.server = 'A'
    canChange.value = false
    let release!: () => void
    permCheck.gate = new Promise<void>(r => { release = r })
    const w = await mountTab()
    expect(w.find('[data-testid="server-profile-locked"]').exists()).toBe(false)
    release()
    await flushPromises()
    expect(w.get('[data-testid="server-profile-locked"]').text()).toBe('serverProfile.locked')
    expect(w.get('[data-testid="field-nickname"]').attributes('disabled')).toBeDefined()
  })

  it('limits the fields to 64, 40 and 500 characters', async () => {
    query.server = 'A'
    const w = await mountTab()
    expect(w.get('[data-testid="field-nickname"]').attributes('maxlength')).toBe('64')
    expect(w.get('[data-testid="field-pronouns"]').attributes('maxlength')).toBe('40')
    expect(w.get('[data-testid="field-bio"]').attributes('maxlength')).toBe('500')
  })

  it('keeps unsaved text when an avatar upload saves', async () => {
    query.server = 'A'
    const { profileService } = await import('@/services/ProfileService')
    vi.mocked(profileService.uploadServerAvatar).mockResolvedValueOnce({ success: true, url: 'http://db.test/av.png' } as any)
    const w = await mountTab()
    await w.get('[data-testid="field-nickname"]').setValue('Typed')
    await w.get('[data-testid="field-bio"]').setValue('Typed bio')
    const input = w.get('[data-testid="field-avatar"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'a.png', { type: 'image/png' })], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(setMy).toHaveBeenCalledWith('A', { avatar_url: 'http://db.test/av.png' })
    expect((w.get('[data-testid="field-nickname"]').element as HTMLInputElement).value).toBe('Typed')
    expect((w.get('[data-testid="field-bio"]').element as HTMLTextAreaElement).value).toBe('Typed bio')
    expect(w.get('[data-testid="save-server-profile"]').attributes('disabled')).toBeUndefined()
  })

  it('Reset on one field keeps unsaved text in the others', async () => {
    query.server = 'A'
    userDataService.setMemberServerProfile('A', ME, { pronouns: 'they/them' })
    const w = await mountTab()
    await w.get('[data-testid="field-nickname"]').setValue('Typed')
    await w.get('[data-testid="reset-pronouns"]').trigger('click')
    await flushPromises()
    expect((w.get('[data-testid="field-pronouns"]').element as HTMLInputElement).value).toBe('')
    expect((w.get('[data-testid="field-nickname"]').element as HTMLInputElement).value).toBe('Typed')
  })

  it('an untouched field follows a stored change; an edited one keeps the edit', async () => {
    query.server = 'A'
    userDataService.setMemberServerProfile('A', ME, { nickname: 'Old', bio: 'Old bio' })
    const w = await mountTab()
    await w.get('[data-testid="field-bio"]').setValue('My edit')
    userDataService.setMemberServerProfile('A', ME, { nickname: 'Mod set', bio: 'Other bio' })
    await flushPromises()
    expect((w.get('[data-testid="field-nickname"]').element as HTMLInputElement).value).toBe('Mod set')
    expect((w.get('[data-testid="field-bio"]').element as HTMLTextAreaElement).value).toBe('My edit')
  })

  it('switching server loads that server\'s values', async () => {
    query.server = 'A'
    userDataService.setMemberServerProfile('B', ME, { nickname: 'Beta nick' })
    const w = await mountTab()
    await w.get('[data-testid="field-nickname"]').setValue('Typed in A')
    await w.get('[data-testid="server-picker"]').setValue('B')
    await flushPromises()
    expect((w.get('[data-testid="field-nickname"]').element as HTMLInputElement).value).toBe('Beta nick')
  })

  it('shows the RPC error in a toast and keeps the cache', async () => {
    query.server = 'A'
    setMy.mockRejectedValueOnce(new Error('nope'))
    const w = await mountTab()
    await w.get('[data-testid="field-nickname"]').setValue('X')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('nope')
    expect(userDataService.getMemberServerFields('A', ME)?.nickname ?? null).toBeNull()
  })
})
