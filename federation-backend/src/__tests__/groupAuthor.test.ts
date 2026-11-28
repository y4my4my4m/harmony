import { describe, it, expect, vi } from 'vitest'

// Messages no profile wrote, on the Note a server's Group sends: the Group is attributedTo, the
// bot, webhook or bridged person is harmony:author.

const cfg = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'host.test', PUBLIC_SUPABASE_URL: 'https://db.host.test', SUPABASE_URL: 'http://kong:8000' }))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    storage: { from: (bucket: string) => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `http://kong:8000/storage/v1/object/public/${bucket}/${path}` } }) }) },
  }),
}))

const { groupAuthorOf, parseGroupAuthor, remoteAuthorMetadata, wireGroupAuthor, HARMONY_AUTHOR } = await import('../activitypub/groupAuthor.js')
const { channelMessageActivity } = await import('../activitypub/channelMessageActivity.js')

const BOT = { id: 'b1', username: 'deploybot', display_name: 'Deploy Bot', avatar_url: 'https://cdn.test/bot.png' }

describe('groupAuthorOf', () => {
  it('names the webhook, then the bridged person, then the bot', () => {
    expect(groupAuthorOf({ bot_id: 'b1', metadata: { webhook: { id: 'w1', name: 'CI', avatar_url: 'https://cdn.test/ci.png' } } }, BOT))
      .toEqual({ kind: 'webhook', id: 'w1', name: 'CI', icon: 'https://cdn.test/ci.png' })
    expect(groupAuthorOf({ bot_id: 'b1', metadata: { webhook: { id: 'w1', name: 'CI' } } }, BOT)?.icon).toBe(BOT.avatar_url)
    expect(groupAuthorOf({ bot_id: 'b1', metadata: { discord_user: { id: '42', username: 'dana', display_name: 'Dana' } } }, BOT))
      .toEqual({ kind: 'bridge', id: 'discord:42', name: 'Dana', source: 'discord' })
    expect(groupAuthorOf({ bot_id: 'b1', metadata: {} }, BOT))
      .toEqual({ kind: 'bot', id: 'b1', name: 'Deploy Bot', icon: BOT.avatar_url })
  })

  it('names a Matrix person by the stored matrix_user instead of the relay bot', () => {
    expect(groupAuthorOf({ bot_id: 'b1', metadata: { matrix_user: { id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.test/sam.png' }, bridge_source: 'matrix' } }, BOT))
      .toEqual({ kind: 'bridge', id: 'matrix:@sam:example.org', name: 'Sam', source: 'matrix', icon: 'https://cdn.test/sam.png' })
    expect(groupAuthorOf({ bot_id: 'b1', metadata: { matrix_user: { id: '@sam:example.org', username: 'sam', display_name: null, avatar_url: null } } }, BOT))
      .toEqual({ kind: 'bridge', id: 'matrix:@sam:example.org', name: 'sam', source: 'matrix' })
  })

  it('resolves a stored avatar path and leaves out the default avatar', () => {
    expect(groupAuthorOf({ bot_id: 'b1' }, { ...BOT, avatar_url: 'avatars/b1.png' })?.icon)
      .toMatch(/^https:\/\/db\.host\.test\/storage\/v1\/object\/public\/avatars\/.*b1\.png$/)
    expect(groupAuthorOf({ bot_id: 'b1' }, { ...BOT, avatar_url: '/default_avatar.webp' })?.icon).toBeUndefined()
  })

  it('is null when nothing names the author', () => {
    expect(groupAuthorOf({ bot_id: 'b1' }, { id: 'b1' })).toBeNull()
    expect(groupAuthorOf({ bot_id: 'b1', metadata: { webhook: { name: 'CI' } } }, BOT)).toBeNull()
  })
})

describe('parseGroupAuthor', () => {
  it('bounds what it keeps', () => {
    const long = 'x'.repeat(300)
    expect(parseGroupAuthor({ kind: 'bot', id: 'b1', name: long })?.name).toHaveLength(100)
    expect(parseGroupAuthor({ kind: 'bot', id: 'b1', name: 'a\u0000b' })?.name).toBe('ab')
    expect(parseGroupAuthor({ kind: 'bot', id: 'b1', name: 'B', icon: 'http://cdn.test/b.png' })).toEqual({ kind: 'bot', id: 'b1', name: 'B' })
    expect(parseGroupAuthor({ kind: 'bridge', id: 'discord:1', name: 'D', source: 'matrix' })?.source).toBe('discord')
  })

  it('accepts Matrix IDs without trusting a conflicting source claim or truncating the ID', () => {
    const id = 'matrix:@' + 's'.repeat(200) + ':example.org'
    expect(parseGroupAuthor({ kind: 'bridge', id, name: 'Sam', source: 'discord' })).toEqual({ kind: 'bridge', id, name: 'Sam', source: 'matrix' })
    expect(parseGroupAuthor({ kind: 'bridge', id: 'matrix:not-a-matrix-id', name: 'Sam' })).toBeNull()
  })

  it('refuses anything else', () => {
    expect(parseGroupAuthor(null)).toBeNull()
    expect(parseGroupAuthor([{ kind: 'bot' }])).toBeNull()
    expect(parseGroupAuthor({ kind: 'person', id: 'p', name: 'P' })).toBeNull()
    expect(parseGroupAuthor({ kind: 'bot', id: '', name: 'B' })).toBeNull()
    expect(parseGroupAuthor({ kind: 'bridge', id: '42', name: 'D' })).toBeNull()
  })
})

// parseGroupAuthor and remoteAuthorMetadata of v1.9.7 (id and name rules; the icon is left out).
function parse197(value: any): { kind: string; id: string; name: string; source?: string } | null {
  const text = (v: unknown, max: number) => {
    if (typeof v !== 'string') return null
    const trimmed = v.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    return trimmed ? trimmed.slice(0, max) : null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!['bot', 'webhook', 'bridge'].includes(value.kind)) return null
  const id = text(value.id, 128)
  const name = text(value.name, 100)
  if (!id || !name) return null
  if (value.kind === 'bridge' && !id.startsWith('discord:')) return null
  return { kind: value.kind, id, name, ...(value.kind === 'bridge' ? { source: 'discord' } : {}) }
}

describe('a Matrix person on the wire', () => {
  const sam = { kind: 'bridge' as const, id: 'matrix:@sam:example.org', name: 'Sam', icon: 'https://cdn.test/sam.png', source: 'matrix' }
  // An MXID is at most 255 characters.
  const long = (last: string) => ({ ...sam, id: `matrix:@${'s'.repeat(240)}${last}:example.org`, name: 'Long' })
  const sent = (author: Parameters<typeof wireGroupAuthor>[0]) => JSON.parse(JSON.stringify(wireGroupAuthor(author)))

  it('reads back whole', () => {
    expect(parseGroupAuthor(sent(sam))).toEqual(sam)
    expect(parseGroupAuthor(sent(long('a')))).toEqual(long('a'))
  })

  it('is a webhook of that name to 1.9.7, under an id it keeps', () => {
    expect(parse197(sent(sam))).toEqual({ kind: 'webhook', id: 'matrix:@sam:example.org', name: 'Sam' })
    const a = parse197(sent(long('a')))
    expect(a).toEqual(parse197(sent(long('a'))))
    expect(a?.id).toBe(sent(long('a')).id)
    expect(a?.id).toHaveLength(128)
    expect(a?.id).not.toBe(parse197(sent(long('b')))?.id)
  })

  it('keeps its id and name well formed where a cut falls inside a character', () => {
    // "matrix:@" and 54 letters are 62 UTF-16 units: the emoji is units 63 and 64.
    const across = (last: string) => ({ ...sam, id: `matrix:@${'s'.repeat(54)}\u{1f600}${'s'.repeat(100)}${last}:example.org`, name: 'Emoji' })
    const wire = sent(across('a'))
    expect(wire.id).toHaveLength(128)
    expect(wire.id.isWellFormed()).toBe(true)
    expect(parse197(wire)?.id).toBe(wire.id)
    expect(wire.id).not.toBe(sent(across('b')).id)
    expect(parseGroupAuthor(wire)).toEqual(across('a'))

    const named = groupAuthorOf({ bot_id: 'b1', metadata: { matrix_user: { id: '@sam:example.org', username: 'sam', display_name: `${'n'.repeat(99)}\u{1f600}` } } }, BOT)
    expect(named?.name).toHaveLength(100)
    expect(named?.name.isWellFormed()).toBe(true)
    expect(parseGroupAuthor({ kind: 'bot', id: 'b1', name: 'a\ud83d' })?.name.isWellFormed()).toBe(true)
  })

  it('is a webhook when bridgeId or source does not name a Matrix person', () => {
    const id = crypto.randomUUID()
    for (const extra of [{ source: 'matrix' }, { source: 'matrix', bridgeId: 'sam' }, { source: 'matrix', bridgeId: 'discord:42' }, { bridgeId: sam.id }, { source: 'discord', bridgeId: sam.id }]) {
      expect(parseGroupAuthor({ kind: 'webhook', id, name: 'CI', ...extra })).toEqual({ kind: 'webhook', id, name: 'CI' })
    }
    expect(parseGroupAuthor({ kind: 'bot', id, name: 'B', source: 'matrix', bridgeId: sam.id })).toEqual({ kind: 'bot', id, name: 'B' })
  })

  it('leaves every other author as it is', () => {
    for (const author of [
      { kind: 'bot' as const, id: 'b1', name: 'B' },
      { kind: 'webhook' as const, id: 'w1', name: 'CI' },
      { kind: 'bridge' as const, id: 'discord:42', name: 'Dana', source: 'discord' },
    ]) {
      expect(sent(author)).toEqual(author)
      expect(parse197(sent(author))).toEqual(author)
    }
  })
})

describe('remoteAuthorMetadata', () => {
  it('stores a federated Matrix author without pretending it is a local authorized bridge bot', () => {
    expect(remoteAuthorMetadata({ kind: 'bridge', id: 'matrix:@sam:example.org', name: 'Sam', source: 'matrix' })).toEqual({
      remote_author: { kind: 'bridge', id: 'matrix:@sam:example.org', name: 'Sam', avatar_url: null, source: 'matrix' }, bridge_source: 'matrix',
    })
  })
  it('stores a bridged person as discord_user too', () => {
    expect(remoteAuthorMetadata({ kind: 'bridge', id: 'discord:42', name: 'Dana', source: 'discord' })).toEqual({
      remote_author: { kind: 'bridge', id: 'discord:42', name: 'Dana', avatar_url: null, source: 'discord' },
      discord_user: { id: '42', username: 'Dana', display_name: 'Dana', avatar_url: null },
      bridge_source: 'discord',
    })
    expect(remoteAuthorMetadata({ kind: 'bot', id: 'b1', name: 'B' })).toEqual({
      remote_author: { kind: 'bot', id: 'b1', name: 'B', avatar_url: null },
    })
  })
})

describe('channelMessageActivity for a Group author', () => {
  it('is attributed to the server\'s Group and carries the author', () => {
    const SERVER = { id: '00000000-0000-4000-8000-000000000001', name: 'S' }
    const author = { kind: 'webhook' as const, id: 'w1', name: 'CI' }
    const activity = channelMessageActivity({
      id: 'row-1', author: null, groupAuthor: author, content: [{ type: 'text', text: 'deployed' }],
      created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', metadata: {},
    }, SERVER, '00000000-0000-4000-8000-000000000002', 'general', 'Create', 'member.test')
    const group = `https://host.test/servers/${SERVER.id}`
    expect(activity.actor).toBe(group)
    expect(activity.object.attributedTo).toBe(group)
    expect(activity.object[HARMONY_AUTHOR]).toEqual(author)
    expect(activity.object.id).toBe('https://host.test/messages/row-1')
  })

  it.each(['Create', 'Update'] as const)('carries a Matrix person as 1.9.7 takes it (%s)', (type) => {
    const author = groupAuthorOf({ bot_id: 'b1', metadata: { matrix_user: { id: '@sam:example.org', username: 'sam', display_name: 'Sam' } } }, BOT)
    const activity = channelMessageActivity({
      id: 'row-1', author: null, groupAuthor: author, content: [{ type: 'text', text: 'hi' }],
      created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z', metadata: {},
    }, { id: '00000000-0000-4000-8000-000000000001', name: 'S' }, '00000000-0000-4000-8000-000000000002', 'general', type, 'member.test')
    expect(parse197(activity.object[HARMONY_AUTHOR])).toEqual({ kind: 'webhook', id: 'matrix:@sam:example.org', name: 'Sam' })
    expect(parseGroupAuthor(activity.object[HARMONY_AUTHOR])).toEqual(author)
  })
})
