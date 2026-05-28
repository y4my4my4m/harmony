import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

vi.mock('../permissionsService', () => ({
  canUserCreateInvites: vi.fn().mockResolvedValue(true),
  getInviteConstraints: vi.fn().mockResolvedValue({
    defaultExpiration: 0,
    maxExpiration: 0,
    maxUses: 0,
    allowTemporary: true,
  }),
}))

vi.mock('vue-toastification', () => ({
  useToast: () => ({ info: vi.fn(), error: vi.fn() }),
}))

import { generateInviteUrl, acceptInvite } from '@/services/inviteService'

type InviteRow = {
  id: string
  code: string
  server_id: string
  created_by: string
  expires_at: string | null
  max_uses: number | null
  uses: number | null
  used: boolean
  temporary: boolean
  created_at: string
}

let invites: InviteRow[] = []
let userServers: Array<{ user_id: string; server_id: string }> = []
let lastInsertedInvite: Partial<InviteRow> | null = null

function inviteBuilder() {
  let filterField: string | null = null
  let filterValue: any = null

  const builder: any = {
    insert: (rowOrRows: any) => {
      const row = Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows
      lastInsertedInvite = { ...row }
      const created: InviteRow = {
        id: 'invite-' + invites.length,
        created_at: new Date().toISOString(),
        used: row.used ?? false,
        temporary: row.temporary ?? false,
        uses: row.uses ?? 0,
        max_uses: row.max_uses ?? null,
        expires_at: row.expires_at ?? null,
        ...row,
      }
      invites.push(created)
      return {
        select: () => ({
          single: () => Promise.resolve({ data: created, error: null }),
        }),
      }
    },
    select: () => builder,
    eq: (field: string, value: any) => {
      filterField = field
      filterValue = value
      return builder
    },
    single: () => {
      const row = invites.find((r: any) => r[filterField as string] === filterValue) || null
      const error = row ? null : { code: 'PGRST116', message: 'not found' }
      return Promise.resolve({ data: row, error })
    },
    maybeSingle: () => {
      const row = invites.find((r: any) => r[filterField as string] === filterValue) || null
      return Promise.resolve({ data: row, error: null })
    },
    update: (patch: Partial<InviteRow>) => ({
      eq: (field: string, value: any) => {
        const row = invites.find((r: any) => r[field] === value)
        if (row) Object.assign(row, patch)
        return Promise.resolve({ error: null })
      },
    }),
    order: () => builder,
  }
  return builder
}

function userServerBuilder() {
  const builder: any = {
    insert: (rowOrRows: any) => {
      const row = Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows
      const exists = userServers.some(us => us.user_id === row.user_id && us.server_id === row.server_id)
      if (exists) return Promise.resolve({ error: { code: '23505', message: 'duplicate' } })
      userServers.push({ user_id: row.user_id, server_id: row.server_id })
      return Promise.resolve({ error: null })
    },
    select: () => builder,
    eq: (field: string, value: any) => {
      const cloned: any = { ...builder }
      cloned.eq = (f2: string, v2: any) => {
        const found = userServers.find(
          us => (us as any)[field] === value && (us as any)[f2] === v2,
        )
        return {
          single: () => Promise.resolve({ data: found || null, error: found ? null : { code: 'PGRST116' } }),
          maybeSingle: () => Promise.resolve({ data: found || null, error: null }),
        }
      }
      return cloned
    },
  }
  return builder
}

beforeEach(() => {
  invites = []
  userServers = []
  lastInsertedInvite = null
  vi.clearAllMocks()

  ;(supabase.from as any).mockImplementation((table: string) => {
    if (table === 'invites') return inviteBuilder()
    if (table === 'user_servers') return userServerBuilder()
    throw new Error(`Unhandled table: ${table}`)
  })

  // After the 20260520 RLS hardening, `acceptInvite` reads invites through
  // the `lookup_invite_by_code` SECURITY DEFINER RPC (direct SELECT on
  // `invites` is blocked for non-owners). The test must mock that RPC the
  // same way it mocks `from('invites')`, or the lookup returns `undefined`
  // and every test path collapses into the "Invalid invite code" branch.
  ;(supabase.rpc as any).mockImplementation((fn: string, params: { p_code?: string } = {}) => {
    if (fn === 'lookup_invite_by_code') {
      const row = invites.find(i => i.code === params.p_code) || null
      // The DB function returns a SETOF row (array); we mirror that shape.
      return Promise.resolve({ data: row ? [row] : [], error: null })
    }
    throw new Error(`Unhandled rpc: ${fn}`)
  })
})

describe('inviteService.generateInviteUrl', () => {
  it('persists max_uses and temporary on insert', async () => {
    const result = await generateInviteUrl('server-1', 'user-1', { maxUses: 3, temporary: true })
    expect(result.success).toBe(true)
    expect(lastInsertedInvite).toBeTruthy()
    expect(lastInsertedInvite!.max_uses).toBe(3)
    expect(lastInsertedInvite!.uses).toBe(0)
    expect(lastInsertedInvite!.temporary).toBe(true)
    expect(lastInsertedInvite!.used).toBe(false)
  })

  it('maps unlimited (maxUses: 0) to NULL', async () => {
    const result = await generateInviteUrl('server-1', 'user-1', { maxUses: 0 })
    expect(result.success).toBe(true)
    expect(lastInsertedInvite!.max_uses).toBeNull()
  })

  it('persists 0 uses by default', async () => {
    const result = await generateInviteUrl('server-1', 'user-1', {})
    expect(result.success).toBe(true)
    expect(lastInsertedInvite!.uses).toBe(0)
  })
})

describe('inviteService.acceptInvite', () => {
  beforeEach(() => {
    invites.push({
      id: 'invite-1',
      code: 'CODE123',
      server_id: 'server-1',
      created_by: 'creator-1',
      expires_at: null,
      max_uses: 2,
      uses: 0,
      used: false,
      temporary: false,
      created_at: new Date().toISOString(),
    })
  })

  it('joins and increments uses', async () => {
    const result = await acceptInvite('CODE123', 'user-1')
    expect(result.success).toBe(true)
    expect(result.serverId).toBe('server-1')
    expect(invites[0].uses).toBe(1)
    expect(invites[0].used).toBe(false)
  })

  it('marks `used` once the increment reaches max_uses', async () => {
    invites[0].uses = 1
    invites[0].max_uses = 2
    const result = await acceptInvite('CODE123', 'user-2')
    expect(result.success).toBe(true)
    expect(invites[0].uses).toBe(2)
    expect(invites[0].used).toBe(true)
  })

  it('rejects when uses already met max_uses', async () => {
    invites[0].uses = 2
    invites[0].max_uses = 2
    const result = await acceptInvite('CODE123', 'user-3')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/usage limit/i)
  })

  it('treats null uses as 0 instead of NaN', async () => {
    invites[0].uses = null as any
    const result = await acceptInvite('CODE123', 'user-1')
    expect(result.success).toBe(true)
    expect(invites[0].uses).toBe(1)
  })

  it('rejects an expired invite', async () => {
    invites[0].expires_at = new Date(Date.now() - 1000).toISOString()
    const result = await acceptInvite('CODE123', 'user-1')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/expired/i)
  })

  it('rejects single-use invites once they are flagged used', async () => {
    invites[0].used = true
    const result = await acceptInvite('CODE123', 'user-1')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already been used/i)
  })

  it('rejects unknown invite codes', async () => {
    const result = await acceptInvite('NONEXISTENT', 'user-1')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid invite/i)
  })
})
