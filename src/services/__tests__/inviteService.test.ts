import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
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

import { generateInviteUrl, acceptInvite, getInviteInfo } from '@/services/inviteService'
import { waitForInitialLocale } from '@/i18n'

beforeAll(async () => {
  await waitForInitialLocale()
})

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

let rpcCalls: Array<{ fn: string; params: any }> = []
let rpcAnswer: { data: any; error: any } = { data: null, error: null }

beforeEach(() => {
  invites = []
  lastInsertedInvite = null
  rpcCalls = []
  rpcAnswer = { data: null, error: null }
  vi.clearAllMocks()

  ;(supabase.from as any).mockImplementation((table: string) => {
    if (table === 'invites') return inviteBuilder()
    throw new Error(`Unhandled table: ${table}`)
  })

  ;(supabase.rpc as any).mockImplementation((fn: string, params: any) => {
    rpcCalls.push({ fn, params })
    return Promise.resolve(rpcAnswer)
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

// Validation, the use count and the membership are the database's (redeem_invite);
// the client maps its refusals to copy and never writes invites or user_servers.
describe('inviteService.acceptInvite', () => {
  it('redeems through redeem_invite and returns the server', async () => {
    rpcAnswer = { data: { server_id: 'server-1', joined: true }, error: null }
    const result = await acceptInvite('CODE123')
    expect(result).toEqual({ success: true, serverId: 'server-1' })
    expect(rpcCalls).toEqual([{ fn: 'redeem_invite', params: { p_code: 'CODE123' } }])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('treats an existing membership as success', async () => {
    rpcAnswer = { data: { server_id: 'server-1', joined: false }, error: null }
    expect(await acceptInvite('CODE123')).toEqual({ success: true, serverId: 'server-1' })
  })

  it.each([
    ['INVITE_EXHAUSTED: this invite has reached its maximum uses', /usage limit/i],
    ['INVITE_REVOKED: this invite has been revoked', /revoked/i],
    ['INVITE_EXPIRED: this invite has expired', /expired/i],
    ['INVITE_NOT_FOUND: invalid invite code', /invalid invite/i],
    ['BANNED_FROM_SERVER: this account is banned from the server', /banned/i],
  ])('maps %s', async (message, copy) => {
    rpcAnswer = { data: null, error: { message } }
    const result = await acceptInvite('CODE123')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(copy)
  })
})

describe('inviteService.getInviteInfo', () => {
  it('reads the card from get_invite_preview', async () => {
    rpcAnswer = {
      data: {
        status: 'valid', code: 'CODE123', server_id: 'server-1', name: 'Private', description: null,
        icon: null, banner: null, rules: ['be nice', ''], member_count: 4, expires_at: null, is_member: false,
      },
      error: null,
    }
    const { info } = await getInviteInfo('CODE123')
    expect(rpcCalls).toEqual([{ fn: 'get_invite_preview', params: { p_code: 'CODE123' } }])
    expect(info).toMatchObject({ serverId: 'server-1', serverName: 'Private', rules: ['be nice'], memberCount: 4, isMember: false })
  })

  it('reports an invalid invite without a card', async () => {
    rpcAnswer = { data: { status: 'exhausted' }, error: null }
    const result = await getInviteInfo('CODE123')
    expect(result.info).toBeUndefined()
    expect(result.error).toMatch(/maximum uses/i)
  })
})
