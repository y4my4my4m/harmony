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

const { groupAuthorOf, parseGroupAuthor, remoteAuthorMetadata, HARMONY_AUTHOR } = await import('../activitypub/groupAuthor.js')
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

  it('refuses anything else', () => {
    expect(parseGroupAuthor(null)).toBeNull()
    expect(parseGroupAuthor([{ kind: 'bot' }])).toBeNull()
    expect(parseGroupAuthor({ kind: 'person', id: 'p', name: 'P' })).toBeNull()
    expect(parseGroupAuthor({ kind: 'bot', id: '', name: 'B' })).toBeNull()
    expect(parseGroupAuthor({ kind: 'bridge', id: '42', name: 'D' })).toBeNull()
  })
})

describe('remoteAuthorMetadata', () => {
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
})
