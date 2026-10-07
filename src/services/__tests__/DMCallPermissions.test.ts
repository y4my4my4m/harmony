import { describe, it, expect, vi, beforeEach } from 'vitest'

// Caller and receiver gates for DM calls. Busy is a DM call on the receiving
// client, never a server voice channel; mute silences the ring instead of
// refusing it; block lookups fail closed on the receiving side only.

type Result = { data: unknown; error: { message: string } | null }

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Result | ((filters: Record<string, unknown>) => Result)>,
  queried: [] as string[],
  rpc: vi.fn(async () => ({ data: false, error: null })),
}))

vi.mock('@/supabase', () => {
  const from = (table: string) => {
    db.queried.push(table)
    const filters: Record<string, unknown> = {}
    const resolve = async () => {
      const entry = db.tables[table] ?? { data: null, error: null }
      return typeof entry === 'function' ? entry(filters) : entry
    }
    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters[column] = value; return builder },
      is: (column: string, value: unknown) => { filters[column] = value; return builder },
      maybeSingle: resolve,
      single: resolve,
    }
    return builder
  }
  return { supabase: { from, rpc: db.rpc } }
})

const voice = vi.hoisted(() => ({ effectiveChannelId: null as string | null, effectiveServerId: null as string | null }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getUser: () => ({ status: 'online' }) } }))
vi.mock('@/services/DMCallSignaling', () => ({
  dmCallSignaling: { conversationForRoom: (room: string) => (room.includes('mapped') ? 'conv-1' : 'conv-remote') },
}))

import { dmCallPermissions } from '@/services/DMCallPermissions'

const CALLER = 'caller'
const ME = 'me'
const CONV = 'conv-1'
const future = () => new Date(Date.now() + 60_000).toISOString()
const past = () => new Date(Date.now() - 60_000).toISOString()

beforeEach(() => {
  db.tables = {}
  db.queried = []
  db.rpc.mockClear()
  voice.effectiveChannelId = null
  voice.effectiveServerId = null
})

describe('canReceiveCall', () => {
  it('rings normally with no mute', async () => {
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true })
  })

  it('silences a muted conversation instead of refusing', async () => {
    db.tables.notification_channels = (f) => ({
      data: f.user_id === ME && f.conversation_id === CONV && f.channel_id === null ? { muted: true, muted_until: null } : null,
      error: null,
    })
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true, silent: true })
  })

  it('silences a muted caller instead of refusing', async () => {
    db.tables.user_mutes = (f) => ({
      data: f.muter_id === ME && f.muted_user_id === CALLER && f.hide_notifications === true ? { expires_at: future() } : null,
      error: null,
    })
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true, silent: true })
  })

  it('rings when the mute has expired', async () => {
    db.tables.notification_channels = { data: { muted: true, muted_until: past() }, error: null }
    db.tables.user_mutes = { data: { expires_at: past() }, error: null }
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true })
  })

  it('rings when the mute lookups fail', async () => {
    db.tables.notification_channels = { data: null, error: { message: 'rls' } }
    db.tables.user_mutes = { data: null, error: { message: 'network' } }
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true })
  })

  it('fails closed when a block lookup fails', async () => {
    db.tables.user_blocks = { data: null, error: { message: 'network' } }
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV))
      .resolves.toMatchObject({ allowed: false, reason: 'error' })
  })

  it('refuses a blocked caller before the mute is read', async () => {
    db.tables.user_blocks = (f) => ({ data: f.blocker_id === ME ? { id: 'b' } : null, error: null })
    db.tables.notification_channels = { data: { muted: true, muted_until: null }, error: null }
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV))
      .resolves.toMatchObject({ allowed: false, reason: 'blocked' })
  })

  it('is not busy in a server voice channel', async () => {
    voice.effectiveServerId = 'server-1'
    voice.effectiveChannelId = 'voice-channel-1'
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('is busy in, or joining, a DM call of another conversation', async () => {
    voice.effectiveServerId = 'dm'
    voice.effectiveChannelId = 'dm-conv-2'
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV))
      .resolves.toMatchObject({ allowed: false, reason: 'busy' })
  })

  it('is busy in a federated DM call of another conversation', async () => {
    voice.effectiveServerId = 'dm'
    voice.effectiveChannelId = 'federated-dm-elsewhere-1700000000000'
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV))
      .resolves.toMatchObject({ allowed: false, reason: 'busy' })
  })

  it('is not busy in the call of the same conversation', async () => {
    voice.effectiveServerId = 'dm'
    voice.effectiveChannelId = `dm-${CONV}`
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true })
    voice.effectiveChannelId = 'federated-dm-mapped-1700000000000'
    await expect(dmCallPermissions.canReceiveCall(CALLER, ME, CONV)).resolves.toEqual({ allowed: true })
  })
})

describe('canPlaceCall', () => {
  it('does not refuse a receiver who muted the caller or the conversation', async () => {
    db.tables.notification_channels = { data: { muted: true, muted_until: null }, error: null }
    db.tables.user_mutes = { data: { expires_at: null }, error: null }
    await expect(dmCallPermissions.canPlaceCall(CALLER, 'them')).resolves.toEqual({ allowed: true })
    expect(db.queried).not.toContain('notification_channels')
    expect(db.queried).not.toContain('user_mutes')
  })

  it('asks no voice-presence question: busy is the receiver\'s answer', async () => {
    await dmCallPermissions.canPlaceCall(CALLER, 'them')
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('refuses a block either way', async () => {
    db.tables.user_blocks = (f) => ({ data: f.blocker_id === CALLER ? { id: 'b' } : null, error: null })
    await expect(dmCallPermissions.canPlaceCall(CALLER, 'them'))
      .resolves.toMatchObject({ allowed: false, reason: 'blocked', message: 'You have blocked this user' })
  })

  it('lets the ring through when a block lookup fails; ring_dm_call enforces blocks', async () => {
    db.tables.user_blocks = { data: null, error: { message: 'network' } }
    await expect(dmCallPermissions.canPlaceCall(CALLER, 'them')).resolves.toEqual({ allowed: true })
  })
})
