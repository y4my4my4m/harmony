import { afterEach, describe, expect, it, vi } from 'vitest'
import { MigrationSyncRunner, type DueMigration } from '../MigrationSyncRunner'
import { mirrorExternalMediaToStorage } from '../../utils/mirrorExternalMedia.js'

vi.mock('../../config/supabase.js', () => ({
  supabase: {},
  config: { migration: { syncMs: 21_600_000, pollMs: 30_000, budgetMs: 120_000, batch: 100 } },
}))
vi.mock('../../utils/mirrorExternalMedia.js', () => ({ mirrorExternalMediaToStorage: vi.fn() }))

const ENV_BEFORE = { SUPABASE_URL: process.env.SUPABASE_URL, PUBLIC_URL: process.env.PUBLIC_URL }
afterEach(() => {
  for (const [k, v] of Object.entries(ENV_BEFORE)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const SERVER = '11111111-1111-1111-1111-111111111111'
const GUILD = '900'
const due: DueMigration = {
  server_id: SERVER,
  discord_guild_id: GUILD,
  credential_source: 'own',
  sync_requested_at: null,
  last_sync_at: null,
  sync_cursor: null,
}
const ok = <T>(value: T) => ({ ok: true as const, value })
const fail = (status: number, reason = 'x') => ({ ok: false as const, status, reason })

type Link = { user_id: string; discord_user_id: string; sync_fields: string[] }
const link = (n: number, sync_fields: string[] = ['avatar']): Link => ({
  user_id: `u${n}`,
  discord_user_id: `d${n}`,
  sync_fields,
})

function member(over: Record<string, unknown> = {}) {
  return {
    present: true as const,
    member: {
      role_ids: ['1', '2'],
      nick: 'Nick',
      joined_at: '2020-01-01T00:00:00.000Z',
      timed_out_until: null as string | null,
      guild_avatar_url: 'https://cdn.discordapp.com/guild-av.png',
      guild_banner_url: null as string | null,
      user: {
        id: 'd',
        username: 'ann',
        global_name: 'Ann',
        avatar_url: 'https://cdn.discordapp.com/av.png',
        banner_url: null as string | null,
        accent_color: null as number | null,
      },
      ...over,
    },
  }
}

interface Setup {
  links?: Link[]
  roles?: ReturnType<typeof ok> | ReturnType<typeof fail>
  members?: (discordUserId: string) => unknown
  bans?: boolean
  canBan?: boolean
  credsError?: string
  removals?: unknown
  syncMember?: (args: any) => unknown
  now?: () => number
  budgetMs?: number
  batch?: number
  realMirror?: boolean
  loadMigrationFails?: boolean
  noMigrationRow?: boolean
}

function build(s: Setup = {}) {
  const links = s.links ?? []
  const calls: Array<{ fn: string; args: any }> = []
  const rpc = vi.fn(async (fn: string, args: any) => {
    calls.push({ fn, args })
    switch (fn) {
      case 'discord_migration_credentials':
        if (s.credsError) return { data: null, error: { message: s.credsError } }
        return { data: [{ client_id: 'c', client_secret: 's', bot_token: 'tok' }], error: null }
      case 'permission_bit_names':
        return { data: ['ADMINISTRATOR'], error: null }
      case 'discord_migration_links_batch': {
        const rows = links.slice(0, args.p_limit)
        return { data: rows, error: null }
      }
      case 'discord_migration_sync_member':
        return { data: s.syncMember ? s.syncMember(args) : { present: true, roles: { added: ['a'], removed: [] } }, error: null }
      case 'discord_migration_apply_removals':
        return { data: s.removals ?? { applied: args.p_candidates.length, skipped: [] }, error: null }
      default:
        return { data: null, error: null }
    }
  })
  const discord = {
    fetchGuildRoles: vi.fn(async () => s.roles ?? ok([{ id: '1', name: 'r', color: 0, position: 1, permissions: '8' }])),
    fetchGuildMember: vi.fn<(t: string, g: string, id: string) => Promise<any>>(async (_t, _g, id) =>
      ok(s.members ? (s.members(id) as any) : member()),
    ),
    fetchUser: vi.fn(async () => ok({ id: 'd', username: 'ann', global_name: 'Ann', avatar_url: null, banner_url: 'https://cdn.discordapp.com/bn.png', accent_color: 255 })),
    fetchBan: vi.fn(async () => ok(s.bans ?? false)),
  }
  const mirror = vi.fn(async (_url: string, t: { bucket: string; folder: string; stem: string }) => `${t.folder}/${t.stem}-1.png`)
  const loadMigration = vi.fn(async () => {
    if (s.loadMigrationFails) throw new Error('connection reset')
    if (s.noMigrationRow) return null
    return {
    discord_guild_id: GUILD,
    bot_can_ban: s.canBan ?? false,
    state: 'open',
    sync_paused_reason: null,
    }
  })
  const loadLink = vi.fn(async (_s: string, userId: string) => links.find((l) => l.user_id === userId) ?? null)
  const runner = new MigrationSyncRunner({
    rpc: rpc as any,
    discord: discord as any,
    mirror: s.realMirror ? undefined : mirror,
    loadMigration,
    loadLink,
    now: s.now,
    budgetMs: s.budgetMs,
    batch: s.batch,
  })
  const of = (fn: string) => calls.filter((c) => c.fn === fn)
  return { runner, rpc, discord, mirror, calls, of }
}

describe('MigrationSyncRunner.syncServer', () => {
  it('backs off, without pausing, when the migration row cannot be read (a DB error)', async () => {
    const t = build({ loadMigrationFails: true, links: [link(1)] })
    const r = await t.runner.syncServer(due)
    expect(t.of('discord_migration_pause')).toHaveLength(0)
    expect(r.paused).toBeUndefined()
    expect(r.errors).toBe(1)
    expect(t.of('discord_migration_sync_member')).toHaveLength(0)
  })

  it('still pauses with credentials_missing when the migration row is gone', async () => {
    const t = build({ noMigrationRow: true })
    await t.runner.syncServer(due)
    expect(t.of('discord_migration_pause')[0].args).toEqual({ p_server_id: SERVER, p_reason: 'credentials_missing' })
  })

  it('pauses with credentials_missing', async () => {
    const t = build({ credsError: 'MIGRATION_CREDENTIALS_MISSING' })
    await t.runner.syncServer(due)
    expect(t.of('discord_migration_pause')[0].args).toEqual({ p_server_id: SERVER, p_reason: 'credentials_missing' })
    expect(t.of('discord_migration_sync_member')).toHaveLength(0)
  })

  it('pauses_on_guild_403', async () => {
    const t = build({ roles: fail(403), links: [link(1)] })
    const r = await t.runner.syncServer(due)
    expect(t.of('discord_migration_pause')[0].args).toEqual({ p_server_id: SERVER, p_reason: 'bot_not_in_guild' })
    expect(r.paused).toBe('bot_not_in_guild')
    expect(t.of('discord_migration_sync_member')).toHaveLength(0)
    expect(t.of('discord_migration_apply_removals')).toHaveLength(0)
    expect(t.of('discord_migration_record_sync')).toHaveLength(0)
  })

  it('pauses with token_invalid on 401', async () => {
    const t = build({ roles: fail(401) })
    await t.runner.syncServer(due)
    expect(t.of('discord_migration_pause')[0].args.p_reason).toBe('token_invalid')
  })

  it('stores the roles snapshot with Harmony masks', async () => {
    const t = build()
    await t.runner.syncServer(due)
    const stored = t.of('discord_migration_store_discord_roles')[0].args
    expect(stored.p_server_id).toBe(SERVER)
    expect(stored.p_roles[0]).toMatchObject({ id: '1', name: 'r' })
    expect(typeof stored.p_roles[0].harmony_permissions).toBe('string')
  })

  it('passes absent members as candidates in one apply_removals call; bans only checked when the bot can ban', async () => {
    const links = [link(1), link(2), link(3)]
    const members = (id: string) => (id === 'd1' ? member() : { present: false })
    const noBan = build({ links, members, canBan: false })
    await noBan.runner.syncServer(due)
    expect(noBan.discord.fetchBan).not.toHaveBeenCalled()
    expect(noBan.of('discord_migration_apply_removals')).toHaveLength(1)
    expect(noBan.of('discord_migration_apply_removals')[0].args.p_candidates).toEqual([
      { user_id: 'u2', kind: 'left' },
      { user_id: 'u3', kind: 'left' },
    ])

    const withBan = build({ links, members, canBan: true, bans: true })
    await withBan.runner.syncServer(due)
    expect(withBan.discord.fetchBan).toHaveBeenCalledTimes(2)
    expect(withBan.of('discord_migration_apply_removals')[0].args.p_candidates).toEqual([
      { user_id: 'u2', kind: 'banned' },
      { user_id: 'u3', kind: 'banned' },
    ])
  })

  it('mirrors only opted-in media and skips fetchUser for server_avatar', async () => {
    const t = build({ links: [link(1, ['server_avatar'])] })
    await t.runner.syncServer(due)
    expect(t.discord.fetchUser).not.toHaveBeenCalled()
    expect(t.mirror).toHaveBeenCalledTimes(1)
    expect(t.mirror.mock.calls[0][0]).toBe('https://cdn.discordapp.com/guild-av.png')
    const profile = t.of('discord_migration_sync_member')[0].args.p_member.profile
    expect(Object.keys(profile)).toEqual(['server_avatar_url'])
    expect(profile.server_avatar_url).not.toContain('discordapp')
  })

  it('fetches the user for banner and accent_color and never passes a CDN URL', async () => {
    const t = build({ links: [link(1, ['banner', 'accent_color'])] })
    await t.runner.syncServer(due)
    expect(t.discord.fetchUser).toHaveBeenCalledTimes(1)
    const profile = t.of('discord_migration_sync_member')[0].args.p_member.profile
    expect(profile.accent_color).toBe(255)
    expect(profile.banner_url).toBe('u1/banner-1.png')
    expect(JSON.stringify(profile)).not.toContain('discordapp')
  })

  it('stores public URLs for avatars and paths for banners, as the web app does', async () => {
    process.env.SUPABASE_URL = 'http://kong:8000'
    process.env.PUBLIC_URL = 'https://chat.example'
    vi.mocked(mirrorExternalMediaToStorage).mockImplementation(async (_u, o) => {
      const t = o.target!
      const path = `${t.folder}/${t.stem}-1.png`
      return { path, url: `http://kong:8000/storage/v1/object/public/${t.bucket}/${path}`, contentType: 'image/png' }
    })
    const t = build({ realMirror: true, links: [link(1, ['avatar', 'server_avatar', 'server_banner'])], members: () => member({ guild_banner_url: 'https://cdn.discordapp.com/gb.png' }) })
    await t.runner.syncServer(due)
    const profile = t.of('discord_migration_sync_member')[0].args.p_member.profile
    expect(profile.avatar_url).toBe('https://chat.example/storage/v1/object/public/avatars/u1/avatar-1.png')
    expect(profile.server_avatar_url).toBe(`https://chat.example/storage/v1/object/public/avatars/u1/servers/${SERVER}/avatar-1.png`)
    expect(profile.server_banner_url).toBe(`u1/servers/${SERVER}/banner-1.png`)
  })

  it('omits a profile key when mirroring fails', async () => {
    const t = build({ links: [link(1, ['avatar', 'display_name'])] })
    t.mirror.mockRejectedValueOnce(new Error('boom'))
    await t.runner.syncServer(due)
    const profile = t.of('discord_migration_sync_member')[0].args.p_member.profile
    expect(profile).toEqual({ display_name: 'Ann' })
  })

  it('passes timed_out_until and joined_at through', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString()
    const t = build({ links: [link(1)], members: () => member({ timed_out_until: until }) })
    await t.runner.syncServer(due)
    const m = t.of('discord_migration_sync_member')[0].args.p_member
    expect(m).toMatchObject({ present: true, joined_at: '2020-01-01T00:00:00.000Z', timed_out_until: until, role_ids: ['1', '2'] })
  })

  it('stops at the budget and still records the sync with the pass start time', async () => {
    let clock = 1_000_000
    const t = build({
      links: [link(1), link(2), link(3)],
      batch: 1,
      budgetMs: 100,
      now: () => clock,
      syncMember: () => {
        clock += 60
        return { present: true, roles: { added: [], removed: [] } }
      },
    })
    // links_batch is stateless in the fake; serve unseen rows
    const r = await t.runner.syncServer(due)
    expect(r.checked).toBeLessThan(3)
    const rec = t.of('discord_migration_record_sync')
    expect(rec).toHaveLength(1)
    expect(rec[0].args.p_started_at).toBe(new Date(1_000_000).toISOString())
    expect(rec[0].args.p_complete).toBe(false)
  })

  it('records a pass that walked every link as complete', async () => {
    const t = build({ links: [link(1), link(2)] })
    await t.runner.syncServer(due)
    expect(t.of('discord_migration_record_sync')[0].args.p_complete).toBe(true)
  })

  it('does not count a timeout for a skipped member', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString()
    const t = build({ links: [link(1)], members: () => member({ timed_out_until: until }), syncMember: () => ({ skipped: 'no_link' }) })
    const r = await t.runner.syncServer(due)
    expect(r.timeouts).toBe(0)
    const ok = build({
      links: [link(1)],
      members: () => member({ timed_out_until: until }),
      syncMember: () => ({ present: true, roles: { added: [], removed: [] }, timeout_changed: true }),
    })
    expect((await ok.runner.syncServer(due)).timeouts).toBe(1)
  })

  it('does not count a timeout the database left alone', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString()
    const t = build({
      links: [link(1)],
      members: () => member({ timed_out_until: until }),
      syncMember: () => ({ present: true, roles: { added: [], removed: [] }, timeout_changed: false }),
    })
    expect((await t.runner.syncServer(due)).timeouts).toBe(0)
  })

  it('pauses with discord_errors when over half the member fetches fail, applying no removals', async () => {
    const t = build({ links: [link(1), link(2), link(3), link(4)], members: (id) => (id === 'd1' ? { present: false } : null) })
    t.discord.fetchGuildMember.mockImplementation(async (_t: string, _g: string, id: string) =>
      id === 'd1' ? ok({ present: false } as any) : fail(500),
    )
    const r = await t.runner.syncServer(due)
    expect(r.paused).toBe('discord_errors')
    expect(t.of('discord_migration_pause')[0].args.p_reason).toBe('discord_errors')
    expect(t.of('discord_migration_apply_removals')).toHaveLength(0)
  })

  it('counts a throwing Discord call as an error and continues', async () => {
    const t = build({ links: [link(1), link(2), link(3)] })
    t.discord.fetchGuildMember.mockImplementationOnce(async () => {
      throw new TypeError('malformed')
    })
    const r = await t.runner.syncServer(due)
    expect(r.errors).toBe(1)
    expect(t.of('discord_migration_sync_member')).toHaveLength(2)
  })

  it('reports paused when apply_removals trips the brake', async () => {
    const t = build({ links: [link(1)], members: () => ({ present: false }), removals: { paused: true } })
    const r = await t.runner.syncServer(due)
    expect(r.paused).toBe('removal_brake')
  })
})

describe('MigrationSyncRunner backoff', () => {
  function backoffSetup() {
    let clock = 5_000_000
    const t = build({ links: [link(1)], now: () => clock })
    const base = t.rpc.getMockImplementation()!
    t.rpc.mockImplementation(async (fn: string, args: any) =>
      fn === 'discord_migration_due' ? { data: [due], error: null } : base(fn, args),
    )
    return { t, advance: (ms: number) => (clock += ms) }
  }

  it('skips a failing server until the delay passes, doubling it, and resets after a success', async () => {
    const { t, advance } = backoffSetup()
    t.discord.fetchGuildRoles.mockResolvedValue(fail(500) as any)
    await t.runner.runOnce()
    expect(t.discord.fetchGuildRoles).toHaveBeenCalledTimes(1)
    await t.runner.runOnce()
    expect(t.discord.fetchGuildRoles).toHaveBeenCalledTimes(1)
    advance(61_000)
    await t.runner.runOnce()
    expect(t.discord.fetchGuildRoles).toHaveBeenCalledTimes(2)
    // second failure: the wait doubled to 2 minutes
    advance(61_000)
    await t.runner.runOnce()
    expect(t.discord.fetchGuildRoles).toHaveBeenCalledTimes(2)
    advance(60_000)
    t.discord.fetchGuildRoles.mockResolvedValue(ok([]) as any)
    await t.runner.runOnce()
    expect(t.discord.fetchGuildRoles).toHaveBeenCalledTimes(3)
    expect(t.of('discord_migration_record_sync')).toHaveLength(1)
    // reset: a new failure waits only a minute again
    t.discord.fetchGuildRoles.mockResolvedValue(fail(500) as any)
    await t.runner.runOnce()
    expect(t.discord.fetchGuildRoles).toHaveBeenCalledTimes(4)
    advance(61_000)
    await t.runner.runOnce()
    expect(t.discord.fetchGuildRoles).toHaveBeenCalledTimes(5)
  })

  it('backs off when credentials cannot be read for another reason', async () => {
    const { t } = backoffSetup()
    const base = t.rpc.getMockImplementation()!
    t.rpc.mockImplementation(async (fn: string, args: any) =>
      fn === 'discord_migration_credentials' ? { data: null, error: { message: 'db down' } } : base(fn, args),
    )
    await t.runner.runOnce()
    await t.runner.runOnce()
    expect(t.rpc.mock.calls.filter((c) => c[0] === 'discord_migration_credentials')).toHaveLength(1)
    expect(t.rpc.mock.calls.filter((c) => c[0] === 'discord_migration_pause')).toHaveLength(0)
  })
})

describe('MigrationSyncRunner.runOnce / syncOne', () => {
  it('does not overlap when called twice concurrently', async () => {
    const t = build()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    t.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'discord_migration_due') {
        await gate
        return { data: [], error: null }
      }
      return { data: null, error: null }
    })
    const a = t.runner.runOnce()
    const b = t.runner.runOnce()
    release()
    await Promise.all([a, b])
    expect(t.rpc.mock.calls.filter((c) => c[0] === 'discord_migration_due')).toHaveLength(1)
  })

  it('syncs each due server', async () => {
    const t = build({ links: [link(1)] })
    const base = t.rpc.getMockImplementation()!
    t.rpc.mockImplementation(async (fn: string, args: any) =>
      fn === 'discord_migration_due' ? { data: [due], error: null } : base(fn, args),
    )
    await t.runner.runOnce()
    expect(t.of('discord_migration_record_sync')).toHaveLength(1)
  })

  it('syncOne syncs one link and never applies removals', async () => {
    const t = build({ links: [link(1), link(2)], members: () => ({ present: false }) })
    await t.runner.syncOne(SERVER, 'u2')
    expect(t.discord.fetchGuildMember).toHaveBeenCalledTimes(1)
    expect(t.discord.fetchGuildMember.mock.calls[0][2]).toBe('d2')
    expect(t.of('discord_migration_apply_removals')).toHaveLength(0)
    expect(t.of('discord_migration_sync_member')).toHaveLength(0)
  })

  it('syncOne writes the member when present', async () => {
    const t = build({ links: [link(1)] })
    await t.runner.syncOne(SERVER, 'u1')
    expect(t.of('discord_migration_sync_member')[0].args.p_user_id).toBe('u1')
  })

  it('syncOne throws when Discord fails', async () => {
    const t = build({ links: [link(1)] })
    t.discord.fetchGuildMember.mockResolvedValueOnce(fail(500) as any)
    await expect(t.runner.syncOne(SERVER, 'u1')).rejects.toThrow()
  })
})
