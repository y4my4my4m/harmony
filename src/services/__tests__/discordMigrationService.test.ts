import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'jwt' } } })) },
  },
}))
vi.mock('@/utils/discordBridgeSetup', () => ({
  resolveHarmonyBaseUrl: () => 'https://harmony.test',
}))

import {
  completePendingClaims,
  requestMySync,
  setMySync,
  claim,
  createAccount,
  DiscordMigrationError,
  preview,
} from '../discordMigrationService'

beforeEach(() => {
  rpc.mockReset()
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  localStorage.clear()
})

describe('completePendingClaims', () => {
  it('claims each pending ticket and swallows TICKET_EXPIRED', async () => {
    rpc.mockImplementation(async (name: string, args: any) => {
      if (name === 'discord_migration_my_pending_claims') {
        return { data: [{ ticket: 'a', server_id: 's1' }, { ticket: 'b', server_id: 's2' }, { ticket: 'c', server_id: 's3' }], error: null }
      }
      if (name === 'discord_migration_claim') {
        if (args.p_ticket === 'b') return { data: null, error: { message: 'TICKET_EXPIRED' } }
        return { data: { server_id: args.p_ticket === 'a' ? 's1' : 's3', roles_granted: ['Mod'] }, error: null }
      }
      throw new Error(`unexpected ${name}`)
    })
    const results = await completePendingClaims()
    expect(results.map(r => r.serverId)).toEqual(['s1', 's3'])
    expect(rpc.mock.calls.filter(c => c[0] === 'discord_migration_claim')).toHaveLength(3)
  })

  it('applies the toggles saved for the ticket after its claim', async () => {
    localStorage.setItem('discord-migration-sync:a', JSON.stringify({ fields: ['avatar'], savedAt: Date.now() }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })))
    rpc.mockImplementation(async (name: string) => {
      if (name === 'discord_migration_my_pending_claims') return { data: [{ ticket: 'a', server_id: 's1' }], error: null }
      if (name === 'discord_migration_claim') return { data: { server_id: 's1', roles_granted: [] }, error: null }
      return { data: null, error: null }
    })
    await completePendingClaims()
    expect(rpc).toHaveBeenCalledWith('discord_migration_set_my_sync', { p_server_id: 's1', p_fields: ['avatar'] })
    expect(localStorage.getItem('discord-migration-sync:a')).toBeNull()
  })
})

describe('completePendingClaims fresh sync', () => {
  const pending = (ticket: string, server: string) => async (name: string) => {
    if (name === 'discord_migration_my_pending_claims') return { data: [{ ticket, server_id: server }], error: null }
    if (name === 'discord_migration_claim') return { data: { server_id: server, roles_granted: [] }, error: null }
    return { data: null, error: null }
  }

  it('asks the gateway to sync after a claim even when no fields were chosen', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    rpc.mockImplementation(pending('a', 's1'))
    await completePendingClaims()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://harmony.test/bot-gateway/bridge/v2/migrate/me/s1/sync',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not ask for a sync when the claim is refused', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    rpc.mockImplementation(async (name: string) => {
      if (name === 'discord_migration_my_pending_claims') return { data: [{ ticket: 'a' }], error: null }
      return { data: null, error: { message: 'TICKET_EXPIRED' } }
    })
    await completePendingClaims()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a failing sync request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    rpc.mockImplementation(pending('a', 's1'))
    await expect(completePendingClaims()).resolves.toHaveLength(1)
  })
})

describe('requestMySync', () => {
  it('posts to the gateway with the session token and never throws', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestMySync('srv')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://harmony.test/bot-gateway/bridge/v2/migrate/me/srv/sync',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer jwt' }) }),
    )
  })
})

describe('saved sync choices', () => {
  const pending = (ticket: string) => rpc.mockImplementation(async (name: string) => {
    if (name === 'discord_migration_my_pending_claims') return { data: [{ ticket, server_id: 's1' }], error: null }
    if (name === 'discord_migration_claim') return { data: null, error: { message: 'HARMONY_BANNED' } }
    return { data: null, error: null }
  })

  it('is removed after any final claim error', async () => {
    localStorage.setItem('discord-migration-sync:a', JSON.stringify({ fields: ['avatar'], savedAt: Date.now() }))
    pending('a')
    await completePendingClaims()
    expect(localStorage.getItem('discord-migration-sync:a')).toBeNull()
  })

  it('older than seven days is ignored and deleted', async () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000
    localStorage.setItem('discord-migration-sync:b', JSON.stringify({ fields: ['avatar'], savedAt: old }))
    rpc.mockImplementation(async (name: string) => {
      if (name === 'discord_migration_my_pending_claims') return { data: [{ ticket: 'b', server_id: 's1' }], error: null }
      if (name === 'discord_migration_claim') return { data: { server_id: 's1', roles_granted: [] }, error: null }
      return { data: null, error: null }
    })
    await completePendingClaims()
    expect(rpc.mock.calls.some(c => c[0] === 'discord_migration_set_my_sync')).toBe(false)
    expect(localStorage.getItem('discord-migration-sync:b')).toBeNull()
  })
})

describe('claim', () => {
  it('throws a DiscordMigrationError with the lowercased code', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'HARMONY_BANNED' } })
    await expect(claim('t')).rejects.toMatchObject({ code: 'harmony_banned' })
    await expect(claim('t')).rejects.toBeInstanceOf(DiscordMigrationError)
  })
})

describe('preview', () => {
  it('maps the rpc payload', async () => {
    rpc.mockResolvedValue({ data: { server_id: 'srv', server_name: 'Lobby', icon_url: null }, error: null })
    expect(await preview('tok')).toEqual({ serverId: 'srv', serverName: 'Lobby', iconUrl: null })
    expect(rpc).toHaveBeenCalledWith('discord_migration_preview', { p_token: 'tok' })
  })

  it('is null when the migration is not open', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await preview('tok')).toBeNull()
  })
})

describe('setMySync', () => {
  it('saves through the rpc, then asks the gateway to sync now', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    await setMySync('srv', ['server_nickname'])
    expect(rpc).toHaveBeenCalledWith('discord_migration_set_my_sync', { p_server_id: 'srv', p_fields: ['server_nickname'] })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://harmony.test/bot-gateway/bridge/v2/migrate/me/srv/sync',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer jwt' }) }),
    )
  })
})

describe('createAccount', () => {
  it('maps a 409 to its error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'username_taken' }) })))
    await expect(createAccount({ ticket: 't', username: 'a', email: 'a@b.c', password: 'x' }))
      .rejects.toMatchObject({ code: 'username_taken' })
  })

  it('returns needsConfirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, needsConfirmation: true }) })))
    expect(await createAccount({ ticket: 't', username: 'a', email: 'a@b.c', password: 'x' })).toEqual({ needsConfirmation: true })
  })
})
