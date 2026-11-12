/**
 * After Sync the gateway has written the profile as the service role: the client reloads the account
 * profile, the profile store and this server's member fields for the signed-in user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ error: null })),
  fetchUserProfile: vi.fn(async () => ({})),
  storeFetch: vi.fn(async () => {}),
  loadMy: vi.fn(async () => {}),
  profileId: vi.fn(async () => 'me'),
}))

vi.mock('@/supabase', () => ({
  supabase: {
    rpc: m.rpc,
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
  },
}))
vi.mock('@/utils/discordBridgeSetup', () => ({ resolveHarmonyBaseUrl: () => 'http://harmony.test' }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: m.profileId } }))
vi.mock('@/services/userDataService', () => ({ userDataService: { fetchUserProfile: m.fetchUserProfile } }))
vi.mock('@/services/serverProfileService', () => ({ loadMyServerProfile: m.loadMy }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ fetchProfile: m.storeFetch }) }))

import { setMySync } from '../discordMigrationService'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

describe('setMySync', () => {
  it('reloads the account profile and the server member fields after the sync ran', async () => {
    await setMySync('srv', ['display_name', 'server_nickname'])
    expect(m.fetchUserProfile).toHaveBeenCalledWith('me', true)
    expect(m.storeFetch).toHaveBeenCalledWith('me', false)
    expect(m.loadMy).toHaveBeenCalledWith('srv', 'me')
  })

  it('reloads nothing when no field is chosen, since nothing was copied', async () => {
    await setMySync('srv', [])
    expect(m.fetchUserProfile).not.toHaveBeenCalled()
    expect(m.loadMy).not.toHaveBeenCalled()
  })

  it('still succeeds when the reload fails', async () => {
    m.loadMy.mockRejectedValueOnce(new Error('offline'))
    await expect(setMySync('srv', ['avatar'])).resolves.toBeUndefined()
  })
})
