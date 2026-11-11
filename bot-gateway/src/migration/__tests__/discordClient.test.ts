import { describe, expect, it, vi } from 'vitest'
import {
  exchangeUserCode,
  fetchApplication,
  fetchBan,
  fetchBotPermissionsInGuild,
  fetchCurrentUser,
  fetchGuildChannels,
  fetchGuildMember,
  fetchGuildRoles,
  fetchUser,
  migrateAuthorizeUrl,
} from '../discordClient'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function stub(...responses: Response[]) {
  const fn = vi.fn()
  for (const r of responses) fn.mockResolvedValueOnce(r)
  return { fn, fetchImpl: fn as unknown as typeof fetch }
}

const USER = { id: '5', username: 'ann', global_name: 'Ann', avatar: 'av', banner: 'bn', accent_color: 123 }

describe('migrateAuthorizeUrl', () => {
  it('requests identify with the state and prompt=none', () => {
    const url = new URL(migrateAuthorizeUrl('cid', 'https://x/cb', 'st4te'))
    expect(url.pathname).toBe('/oauth2/authorize')
    expect(url.searchParams.get('scope')).toBe('identify')
    expect(url.searchParams.get('state')).toBe('st4te')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('prompt')).toBe('none')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://x/cb')
  })
})

describe('exchangeUserCode', () => {
  it('posts a form and returns the access token', async () => {
    const { fn, fetchImpl } = stub(json({ access_token: 'tok' }))
    const r = await exchangeUserCode({ clientId: 'c', clientSecret: 's', code: 'k', redirectUri: 'https://x/cb' }, { fetchImpl })
    expect(r).toEqual({ ok: true, value: { accessToken: 'tok' } })
    const [url, init] = fn.mock.calls[0]
    expect(String(url)).toMatch(/\/oauth2\/token$/)
    expect(String(init.body)).toContain('grant_type=authorization_code')
  })
  it('fails without echoing the secret', async () => {
    const { fetchImpl } = stub(json({ error: 'invalid_grant' }, 400))
    const r = await exchangeUserCode({ clientId: 'c', clientSecret: 'SECRET', code: 'k', redirectUri: 'u' }, { fetchImpl })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })
})

describe('users', () => {
  it('fetchUser maps banner and accent_color to URLs', async () => {
    const { fn, fetchImpl } = stub(json(USER))
    const r = await fetchUser('BOT', '5', { fetchImpl })
    expect(r).toEqual({
      ok: true,
      value: {
        id: '5', username: 'ann', global_name: 'Ann',
        avatar_url: 'https://cdn.discordapp.com/avatars/5/av.png?size=256',
        banner_url: 'https://cdn.discordapp.com/banners/5/bn.png?size=600',
        accent_color: 123,
      },
    })
    expect(fn.mock.calls[0][1].headers.Authorization).toBe('Bot BOT')
  })
  it('null hashes give null URLs', async () => {
    const { fetchImpl } = stub(json({ ...USER, avatar: null, banner: null, accent_color: null }))
    const r = await fetchUser('BOT', '5', { fetchImpl })
    expect(r.ok && r.value).toMatchObject({ avatar_url: null, banner_url: null, accent_color: null })
  })
  it('fetchCurrentUser uses a Bearer token', async () => {
    const { fn, fetchImpl } = stub(json(USER))
    const r = await fetchCurrentUser('ACCESS', { fetchImpl })
    expect(r.ok).toBe(true)
    expect(String(fn.mock.calls[0][0])).toMatch(/\/users\/@me$/)
    expect(fn.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS')
  })
})

describe('fetchGuildRoles', () => {
  it('excludes managed roles and @everyone', async () => {
    const { fetchImpl } = stub(json([
      { id: 'G', name: '@everyone', color: 0, position: 0, permissions: '1', managed: false },
      { id: 'r1', name: 'Mod', color: 5, position: 2, permissions: '6', managed: false },
      { id: 'r2', name: 'Bot', color: 0, position: 1, permissions: '8', managed: true },
    ]))
    const r = await fetchGuildRoles('BOT', 'G', { fetchImpl })
    expect(r).toEqual({ ok: true, value: [{ id: 'r1', name: 'Mod', color: 5, position: 2, permissions: '6' }] })
  })
})

describe('fetchGuildMember', () => {
  it('404 with code 10007 is not present', async () => {
    const { fetchImpl } = stub(json({ code: 10007, message: 'Unknown Member' }, 404))
    expect(await fetchGuildMember('BOT', 'G', '5', { fetchImpl })).toEqual({ ok: true, value: { present: false } })
  })
  it('404 with code 10004 is a failure', async () => {
    const { fetchImpl } = stub(json({ code: 10004, message: 'Unknown Guild' }, 404))
    const r = await fetchGuildMember('BOT', 'G', '5', { fetchImpl })
    expect(r).toMatchObject({ ok: false, status: 404 })
  })
  it('maps a member payload', async () => {
    const { fetchImpl } = stub(json({
      roles: ['r1'], nick: 'Annie', joined_at: '2024-01-01T00:00:00.000000+00:00',
      communication_disabled_until: '2030-01-01T00:00:00.000000+00:00',
      avatar: 'gav', banner: 'gbn', user: USER,
    }))
    const r = await fetchGuildMember('BOT', 'G', '5', { fetchImpl })
    expect(r).toMatchObject({
      ok: true,
      value: {
        present: true,
        member: {
          role_ids: ['r1'], nick: 'Annie', joined_at: '2024-01-01T00:00:00.000000+00:00',
          timed_out_until: '2030-01-01T00:00:00.000000+00:00',
          guild_avatar_url: 'https://cdn.discordapp.com/guilds/G/users/5/avatars/gav.png?size=256',
          guild_banner_url: 'https://cdn.discordapp.com/guilds/G/users/5/banners/gbn.png?size=600',
          user: { id: '5' },
        },
      },
    })
  })
  it('null optional fields map to null', async () => {
    const { fetchImpl } = stub(json({ roles: [], joined_at: 'x', user: USER }))
    const r = await fetchGuildMember('BOT', 'G', '5', { fetchImpl })
    expect(r.ok && r.value.present && r.value.member).toMatchObject({
      nick: null, timed_out_until: null, guild_avatar_url: null, guild_banner_url: null,
    })
  })
})

describe('fetchBan', () => {
  it('200 is banned, 404 is not', async () => {
    expect(await fetchBan('B', 'G', '5', { fetchImpl: stub(json({ user: USER })).fetchImpl })).toEqual({ ok: true, value: true })
    expect(await fetchBan('B', 'G', '5', { fetchImpl: stub(json({ code: 10026 }, 404)).fetchImpl })).toEqual({ ok: true, value: false })
  })
  it('403 is a failure with status 403', async () => {
    const r = await fetchBan('B', 'G', '5', { fetchImpl: stub(json({ code: 50013 }, 403)).fetchImpl })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })
})

describe('rate limits', () => {
  it('retries once after a 429', async () => {
    const { fn, fetchImpl } = stub(json({ retry_after: 0 }, 429), json(USER))
    const r = await fetchUser('B', '5', { fetchImpl })
    expect(r.ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('fails rate_limited after two 429s', async () => {
    const { fn, fetchImpl } = stub(json({ retry_after: 0 }, 429), json({ retry_after: 0 }, 429))
    const r = await fetchUser('B', '5', { fetchImpl })
    expect(r).toEqual({ ok: false, status: 429, reason: 'rate_limited' })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('network failure', () => {
  it('maps a thrown fetch to status 0 without leaking the token', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom BOTTOKEN')) as unknown as typeof fetch
    const r = await fetchUser('BOTTOKEN', '5', { fetchImpl })
    expect(r).toMatchObject({ ok: false, status: 0 })
    expect(JSON.stringify(r)).not.toContain('BOTTOKEN')
  })
})

describe('fetchApplication / fetchGuildChannels', () => {
  it('returns the application id', async () => {
    const { fn, fetchImpl } = stub(json({ id: '99', name: 'app' }))
    expect(await fetchApplication('B', { fetchImpl })).toEqual({ ok: true, value: { id: '99' } })
    expect(String(fn.mock.calls[0][0])).toMatch(/\/oauth2\/applications\/@me$/)
  })
  it('maps channels to id, name, type, overwrite types', async () => {
    const { fetchImpl } = stub(json([{ id: 'c1', name: 'general', type: 0, permission_overwrites: [{ id: 'x', type: 0, allow: '1', deny: '0' }] }]))
    expect(await fetchGuildChannels('B', 'G', { fetchImpl })).toEqual({
      ok: true,
      value: [{ id: 'c1', name: 'general', type: 0, permission_overwrites: [{ type: 0 }] }],
    })
  })
})

describe('fetchBotPermissionsInGuild', () => {
  const roles = [
    { id: 'G', name: '@everyone', permissions: '0', managed: false },
    { id: 'r1', name: 'Banner', permissions: String(1n << 2n), managed: false },
    { id: 'r2', name: 'Admin', permissions: String(1n << 3n), managed: true },
    { id: 'r3', name: 'Plain', permissions: '1024', managed: false },
  ]
  const member = (rs: string[]) => json({ roles: rs, joined_at: 'x', user: USER })
  it('canBan with BAN_MEMBERS', async () => {
    const { fetchImpl } = stub(json({ id: '5' }), member(['r1']), json(roles))
    expect(await fetchBotPermissionsInGuild('B', 'G', { fetchImpl })).toEqual({ ok: true, value: { canBan: true } })
  })
  it('canBan with ADMINISTRATOR on a managed role', async () => {
    const { fetchImpl } = stub(json({ id: '5' }), member(['r2']), json(roles))
    expect(await fetchBotPermissionsInGuild('B', 'G', { fetchImpl })).toEqual({ ok: true, value: { canBan: true } })
  })
  it('cannot ban without either', async () => {
    const { fetchImpl } = stub(json({ id: '5' }), member(['r3']), json(roles))
    expect(await fetchBotPermissionsInGuild('B', 'G', { fetchImpl })).toEqual({ ok: true, value: { canBan: false } })
  })
  it('fails when the bot is not in the guild', async () => {
    const { fetchImpl } = stub(json({ id: '5' }), json({ code: 10007 }, 404))
    expect(await fetchBotPermissionsInGuild('B', 'G', { fetchImpl })).toMatchObject({ ok: false })
  })
})
