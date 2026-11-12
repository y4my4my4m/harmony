/**
 * Discord members who linked a Harmony account through Migrate from Discord are left out of the
 * bridged member lists (sidebar, mention suggestions, role management) but stay in the lookup cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) } },
}))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (path: string) => `http://gw.test${path}` }))

import {
  clearBridgedUsersCache,
  fetchBridgedChannelUsers,
  fetchBridgedServerUsers,
  findBridgedUserInCache,
} from '../bridgedChannelUsersService'

const member = (id: string) => ({ id, username: `u${id}`, displayName: `User ${id}`, avatarUrl: '', source: 'discord' })

function respond(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })))
}

beforeEach(() => {
  clearBridgedUsersCache()
})

describe('bridged users with linked Harmony accounts', () => {
  it('drops a linked member from the channel list but keeps it findable', async () => {
    respond({ has_bridge: true, users: [member('601'), member('700')], linked_discord_ids: ['601'] })
    const result = await fetchBridgedChannelUsers('ch1')
    expect(result.users.map(u => u.id)).toEqual(['700'])
    expect(findBridgedUserInCache('ch1', '601')?.username).toBe('u601')
  })

  it('drops a linked member from the server list too', async () => {
    respond({ has_bridge: true, users: [member('601'), member('700')], linked_discord_ids: ['601'] })
    const result = await fetchBridgedServerUsers('srv1')
    expect(result.users.map(u => u.id)).toEqual(['700'])
  })

  it('lists everyone when the gateway names nobody (an older gateway, or no links)', async () => {
    respond({ has_bridge: true, users: [member('601'), member('700')] })
    const result = await fetchBridgedChannelUsers('ch2')
    expect(result.users.map(u => u.id)).toEqual(['601', '700'])
  })

  it('has no users without a bridge', async () => {
    respond({ has_bridge: false, users: [member('601')], linked_discord_ids: [] })
    expect((await fetchBridgedChannelUsers('ch3')).users).toEqual([])
  })
})
