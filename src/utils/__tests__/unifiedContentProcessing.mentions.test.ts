import { describe, it, expect, vi, afterEach } from 'vitest'

// profiles table: local alice, and remote doesnm whose instance is a subdomain.
// The vitest VITE_DOMAIN is harmony.test.
const profiles = [
  { id: '00000000-0000-4000-8000-00000000a11c', username: 'alice', domain: 'harmony.test', display_name: 'Alice', is_local: true },
  { id: '00000000-0000-4000-8000-0000000d0e55', username: 'doesnm', domain: 'chat.understars.dev', display_name: 'doesnm', is_local: false },
]

// lookup.fail: every profiles query answers with an error.
const lookup = vi.hoisted(() => ({ fail: false }))

vi.mock('@/supabase', () => {
  const query = () => {
    let rows = [...profiles]
    const q: any = {
      select: () => q,
      in: (col: string, vals: string[]) => { rows = rows.filter((r: any) => vals.includes(r[col])); return q },
      eq: (col: string, v: unknown) => { rows = rows.filter((r: any) => r[col] === v); return q },
      or: (filter: string) => {
        const pairs = [...filter.matchAll(/and\(username\.eq\.([^,]+),domain\.eq\.([^)]+)\)/g)]
        rows = rows.filter((r: any) => pairs.some(([, u, d]) => r.username === u && r.domain === d))
        return q
      },
      then: (resolve: any) => resolve(lookup.fail ? { data: null, error: { message: 'unavailable' } } : { data: rows, error: null }),
    }
    return q
  }
  return {
    supabase: {
      from: () => query(),
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => ({ data: { session: null } }),
      },
      channel: () => ({ on() { return this }, subscribe() { return this } }),
    },
  }
})

import { resolveMentionsUserData, parseContentToMessageParts } from '@/utils/unifiedContentProcessing'

const parse = async (text: string) => parseContentToMessageParts(text, await resolveMentionsUserData(text))
const mentions = (parts: any[]) => parts.filter(p => p.type === 'mention')
const plain = (parts: any[]) => parts.map(p => (p.type === 'text' ? p.text : p.type === 'mention' ? `<${p.username}@${p.domain}>` : `<${p.type}>`)).join('')

describe('parseContentToMessageParts mentions', () => {
  it('keeps a subdomain handle whole', async () => {
    const parts = await parse('interesting does fix already deployed @doesnm@chat.understars.dev')
    expect(mentions(parts)).toEqual([
      expect.objectContaining({
        username: 'doesnm',
        domain: 'chat.understars.dev',
        isLocal: false,
        userId: '00000000-0000-4000-8000-0000000d0e55',
      }),
    ])
    expect(plain(parts)).toBe('interesting does fix already deployed <doesnm@chat.understars.dev>')
  })

  it('leaves user@host without a leading @ as text', async () => {
    const parts = await parse('no, it should be doesnm@chat.understars.dev')
    expect(mentions(parts)).toEqual([])
    expect(plain(parts)).toBe('no, it should be doesnm@chat.understars.dev')
  })

  it('never gives a bare @user the remote profile of that name', async () => {
    const parts = await parse('hi @doesnm')
    expect(mentions(parts)).toEqual([])
    expect(parts).toEqual([{ type: 'text', text: 'hi @doesnm' }])
  })

  it('does not split a dotted continuation into a chip and text', async () => {
    const parts = await parse('hi @doesnm.chat.understars.dev')
    expect(mentions(parts)).toEqual([])
    expect(plain(parts)).toBe('hi @doesnm.chat.understars.dev')
  })

  it('does not fall back to a bare-name profile for an unknown remote handle', async () => {
    const parts = await parse('@doesnm@understars.dev and @doesnm')
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'doesnm', domain: 'understars.dev', isLocal: false, userId: 'unresolved-doesnm@understars.dev' }),
    ])
    expect(plain(parts)).toBe('<doesnm@understars.dev> and @doesnm')
  })

  it('reported message: no chip borrows a profile or the local host', async () => {
    const parts = await parse('deployed @doesnm@understars.dev @doesnm.chat.understars.dev')
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'doesnm', domain: 'understars.dev', isLocal: false, userId: 'unresolved-doesnm@understars.dev' }),
    ])
    expect(plain(parts)).toBe('deployed <doesnm@understars.dev> @doesnm.chat.understars.dev')
  })

  it('excludes trailing punctuation from the host', async () => {
    const parts = await parse('ping @doesnm@chat.understars.dev.')
    expect(mentions(parts)[0]).toMatchObject({ domain: 'chat.understars.dev', userId: '00000000-0000-4000-8000-0000000d0e55' })
    expect(plain(parts)).toBe('ping <doesnm@chat.understars.dev>.')
  })

  it('treats @user@<local host> as the local user', async () => {
    const parts = await parse('hey @alice@harmony.test')
    expect(mentions(parts)[0]).toMatchObject({ username: 'alice', domain: 'harmony.test', isLocal: true, userId: '00000000-0000-4000-8000-00000000a11c' })
  })

  it('leaves @@user as text', async () => {
    const parts = await parse('@@alice')
    expect(mentions(parts)).toEqual([])
  })

  it('leaves handles inside URLs alone', async () => {
    const parts = await parse('see https://chat.understars.dev/@doesnm/123 ok')
    expect(mentions(parts)).toEqual([])
  })

  it('leaves handles inside inline code alone', async () => {
    const parts = await parse('run `@alice` now @alice')
    expect(mentions(parts)).toHaveLength(1)
    expect(plain(parts)).toBe('run `@alice` now <alice@harmony.test>')
  })

  it('leaves handles inside fenced code alone', async () => {
    const parts = await parse('```\n@alice\n```')
    expect(mentions(parts)).toEqual([])
  })
})

// Stored posts held hosts with the next word glued on (spacify.cloudit,
// mastodon.gamedev.placeThis): the handle ends where its host does.
describe('parseContentToMessageParts mention right boundary', () => {
  const cases: Array<[string, string, string]> = [
    ['@kai@spacify.cloud\nit works', 'spacify.cloud', '<kai@spacify.cloud>\nit works'],
    ['@nyx@mastodon.gamedev.place\nThis is it', 'mastodon.gamedev.place', '<nyx@mastodon.gamedev.place>\nThis is it'],
    ['@nyx@mastodon.gamedev.place\r\nThis', 'mastodon.gamedev.place', '<nyx@mastodon.gamedev.place>\r\nThis'],
    ['@kai@spacify.cloud it', 'spacify.cloud', '<kai@spacify.cloud> it'],
    ['@kai@spacify.cloud\tit', 'spacify.cloud', '<kai@spacify.cloud>\tit'],
    ['@kai@spacify.cloud\u00a0it', 'spacify.cloud', '<kai@spacify.cloud>\u00a0it'],
    ['@kai@spacify.cloud.\nThis', 'spacify.cloud', '<kai@spacify.cloud>.\nThis'],
    ['@kai@spacify.cloud, it', 'spacify.cloud', '<kai@spacify.cloud>, it'],
    ['@kai@spacify.cloud! This', 'spacify.cloud', '<kai@spacify.cloud>! This'],
    ['(@kai@spacify.cloud) it', 'spacify.cloud', '(<kai@spacify.cloud>) it'],
    ['@kai@spacify.cloud: it', 'spacify.cloud', '<kai@spacify.cloud>: it'],
    ['@hby@misskey.io\n\nhi', 'misskey.io', '<hby@misskey.io>\n\nhi'],
  ]

  for (const [text, host, rendered] of cases) {
    it(`ends ${JSON.stringify(text)} at ${host}`, async () => {
      const parts = await parse(text)
      expect(mentions(parts).map((m) => m.domain)).toEqual([host])
      expect(plain(parts)).toBe(rendered)
    })
  }

  it('stores an unknown remote handle under its own host', async () => {
    const parts = await parse('@Nyx@Mastodon.Gamedev.Place\nThis')
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'Nyx', domain: 'mastodon.gamedev.place', userId: 'unresolved-Nyx@mastodon.gamedev.place' }),
    ])
  })
})

describe('parseContentToMessageParts backslash escapes', () => {
  it('reads no mention from an escaped @', async () => {
    const parts = await parse('hi \\@alice and @alice')
    expect(mentions(parts)).toHaveLength(1)
    expect(plain(parts)).toBe('hi \\@alice and <alice@harmony.test>')
  })

  it('reads no role mention, Discord mention or @here from an escaped token', async () => {
    for (const text of [
      '\\@role:00000000-0000-4000-8000-000000000001',
      '\\@role:here',
      '\\@d!123:bob',
    ]) {
      const parts = await parse(text)
      expect(parts).toEqual([{ type: 'text', text }])
    }
  })

  it('reads no channel from an escaped #', async () => {
    const parts = await parseContentToMessageParts('\\#general #general', {}, {}, {}, {}, {
      hashtags: 'channels',
      channelDataMap: { general: { id: 'c1', serverId: 's1', name: 'general' } },
    })
    expect(parts.filter((p: any) => p.type === 'channel_mention')).toHaveLength(1)
    expect(parts[0]).toEqual({ type: 'text', text: '\\#general ' })
  })

  it('reads no hashtag from an escaped #', async () => {
    const parts = await parseContentToMessageParts('\\#cats #dogs', {}, {}, {})
    expect(parts.filter((p: any) => p.type === 'hashtag').map((p: any) => p.name)).toEqual(['dogs'])
  })

  it('reads no link from an escaped URL', async () => {
    const parts = await parse('\\https://x.example/a https://y.example/b')
    const urls = parts.filter((p: any) => p.type === 'url').map((p: any) => p.url)
    expect(urls).toEqual(['https://y.example/b'])
  })

  it('reads no emoji from an escaped shortcode', async () => {
    const token = ':discord:party_blob:123456789012345678:'
    const parts = await parseContentToMessageParts(`\\${token} ${token}`, {}, {})
    expect(parts.filter((p: any) => p.type === 'emoji')).toHaveLength(1)
    expect((parts[0] as any).text).toBe(`\\${token} `)
  })
})

// A typed local handle that names no account stays text; picked or typed, an existing
// account is a mention.
describe('parseContentToMessageParts local handles of no account', () => {
  afterEach(() => { lookup.fail = false })

  it('keeps @<no such user> as text', async () => {
    const parts = await parse('@gasdghasidghasdg hello')
    expect(parts).toEqual([{ type: 'text', text: '@gasdghasidghasdg hello' }])
  })

  it('keeps a time written with @ as text', async () => {
    const parts = await parse('see you @5:32 ok')
    expect(parts).toEqual([{ type: 'text', text: 'see you @5:32 ok' }])
  })

  it('keeps the account a mention beside a name of none', async () => {
    const parts = await parse('@alice meet at @5:32, not @nobody_here.')
    expect(plain(parts)).toBe('<alice@harmony.test> meet at @5:32, not @nobody_here.')
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'alice', userId: '00000000-0000-4000-8000-00000000a11c' }),
    ])
  })

  it('keeps the text a handle of no account sits in one part, markdown and all', async () => {
    const parts = await parse('**hey @nobody there**')
    expect(parts).toEqual([{ type: 'text', text: '**hey @nobody there**' }])
  })

  it('keeps @<no such user>@<local host> as typed', async () => {
    const parts = await parse('hi @nobody@Harmony.Test')
    expect(parts).toEqual([{ type: 'text', text: 'hi @nobody@Harmony.Test' }])
  })

  it('reads the exact username only, as the lookup does', async () => {
    const parts = await parse('hi @Alice')
    expect(parts).toEqual([{ type: 'text', text: 'hi @Alice' }])
  })

  it('keeps an unknown remote handle a mention for the federation worker', async () => {
    const parts = await parse('hi @nobody@far.example')
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'nobody', domain: 'far.example', isLocal: false, userId: 'unresolved-nobody@far.example' }),
    ])
  })

  it('keeps a typed @everyone the mass mention beside @everyone@<local host> of no account', async () => {
    const parts = await parseContentToMessageParts('@everyone@harmony.test @everyone', await resolveMentionsUserData('@everyone@harmony.test @everyone'),
      {}, {}, {}, { massMentions: { allowed: true, everyoneRole: { id: 'r1', name: 'everyone', color: null } } } as any)
    expect(parts).toEqual([
      { type: 'text', text: '@everyone@harmony.test ' },
      { type: 'role_mention', roleId: 'r1', roleName: 'everyone', roleColor: null },
    ])
  })

  it('stores the mention unresolved, as before, when the lookup fails', async () => {
    lookup.fail = true
    const parts = await parse('hi @nobody')
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'nobody', isLocal: true, userId: 'unresolved-nobody' }),
    ])
  })

  it('stores the mention unresolved, as before, under a map from elsewhere', async () => {
    const parts = await parseContentToMessageParts('hi @nobody', {})
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'nobody', isLocal: true, userId: 'unresolved-nobody' }),
    ])
  })

  it('stores a handle the lookup never saw unresolved, not as text', async () => {
    const map = await resolveMentionsUserData('hi @nobody')
    const parts = await parseContentToMessageParts('hi @nobody and @other', map)
    expect(plain(parts)).toBe('hi @nobody and <other@harmony.test>')
  })
})
