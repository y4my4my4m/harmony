import { describe, it, expect, vi } from 'vitest'

// profiles table: local alice, and remote doesnm whose instance is a subdomain.
// The vitest VITE_DOMAIN is harmony.test.
const profiles = [
  { id: '00000000-0000-4000-8000-00000000a11c', username: 'alice', domain: 'harmony.test', display_name: 'Alice', is_local: true },
  { id: '00000000-0000-4000-8000-0000000d0e55', username: 'doesnm', domain: 'chat.understars.dev', display_name: 'doesnm', is_local: false },
]

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
      then: (resolve: any) => resolve({ data: rows, error: null }),
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

  it('never gives a bare @user the local host when only a remote profile has that name', async () => {
    const parts = await parse('hi @doesnm')
    const [m] = mentions(parts)
    expect(m.userId).not.toBe('00000000-0000-4000-8000-0000000d0e55')
    expect(m.userId).toBe('unresolved-doesnm')
  })

  it('does not split a dotted continuation into a chip and text', async () => {
    const parts = await parse('hi @doesnm.chat.understars.dev')
    expect(mentions(parts)).toEqual([])
    expect(plain(parts)).toBe('hi @doesnm.chat.understars.dev')
  })

  it('does not fall back to a bare-name profile for an unknown remote handle', async () => {
    const parts = await parse('@doesnm@understars.dev and @doesnm')
    const [first] = mentions(parts)
    expect(first).toMatchObject({ username: 'doesnm', domain: 'understars.dev', isLocal: false, userId: 'unresolved-doesnm@understars.dev' })
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
