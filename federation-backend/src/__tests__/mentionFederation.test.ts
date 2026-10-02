import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'har.mony.lol',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
  config: { INSTANCE_DOMAIN: 'har.mony.lol' },
}))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: vi.fn() }))
vi.mock('../utils/urlUtils.js', () => ({
  getFullAvatarUrl: vi.fn((url: string | null) => url || null),
  getFullBannerUrl: vi.fn((url: string | null) => url || null),
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { noteToContent } from '../activitypub/converters/fromActivityPub.js'
import { postToNote } from '../activitypub/converters/toActivityPub.js'
import { convertContentToHTML, extractActivityPubTags } from '../utils/contentUtils.js'
import { normalizeInboundMentions } from '../utils/mentionParts.js'

const SUB = 'chat.understars.dev'
const HREF = `https://${SUB}/users/doesnm`
const mentions = (parts: any[]) => parts.filter((p: any) => p.type === 'mention')
const plain = (parts: any[]) =>
  parts.map((p: any) => (p.type === 'text' ? p.text : p.type === 'mention' ? `<${p.username}@${p.domain}>` : `<${p.type}>`)).join('')

describe('noteToContent mentions from a subdomain instance', () => {
  it('keeps a full subdomain handle whole when the tag name is the bare user', () => {
    const parts = noteToContent({
      content: `<p>interesting does fix already deployed <span class="h-card"><a href="${HREF}" class="u-url mention">@doesnm@${SUB}</a></span></p>`,
      tag: [{ type: 'Mention', href: HREF, name: '@doesnm' }],
    })
    expect(mentions(parts)).toEqual([
      expect.objectContaining({ username: 'doesnm', domain: SUB, isLocal: false, userId: HREF }),
    ])
    expect(plain(parts)).toBe(`interesting does fix already deployed <doesnm@${SUB}>`)
  })

  it('takes the host from the full tag name', () => {
    const parts = noteToContent({
      content: `<p>hi <a href="${HREF}" class="mention">@doesnm@${SUB}</a>!</p>`,
      tag: [{ type: 'Mention', href: HREF, name: `@doesnm@${SUB}` }],
    })
    expect(plain(parts)).toBe(`hi <doesnm@${SUB}>!`)
  })

  it('matches the Mastodon short form against a full tag name', () => {
    const parts = noteToContent({
      content: `<p>hi <span class="h-card"><a href="https://${SUB}/@doesnm" class="u-url mention">@<span>doesnm</span></a></span> ok</p>`,
      tag: [{ type: 'Mention', href: HREF, name: `@doesnm@${SUB}` }],
    })
    expect(plain(parts)).toBe(`hi <doesnm@${SUB}> ok`)
  })

  it('does not chip a user@host without a leading @', () => {
    const parts = noteToContent({
      content: `<p>no, it should be doesnm@${SUB}</p>`,
      tag: [{ type: 'Mention', href: HREF, name: `@doesnm@${SUB}` }],
    })
    expect(mentions(parts)).toEqual([])
    expect(plain(parts)).toBe(`no, it should be doesnm@${SUB}`)
  })

  it('emits one chip for duplicate tags of one mention', () => {
    const parts = noteToContent({
      content: `<p>hey @doesnm@${SUB}</p>`,
      tag: [
        { type: 'Mention', href: HREF, name: `@doesnm@${SUB}` },
        { type: 'Mention', href: HREF, name: '@doesnm' },
      ],
    })
    expect(mentions(parts)).toHaveLength(1)
    expect(plain(parts)).toBe(`hey <doesnm@${SUB}>`)
  })

  it('excludes trailing punctuation from the host', () => {
    const parts = noteToContent({
      content: `<p>ping @doesnm@${SUB}.</p>`,
      tag: [{ type: 'Mention', href: HREF, name: `@doesnm@${SUB}` }],
    })
    expect(plain(parts)).toBe(`ping <doesnm@${SUB}>.`)
  })

  it('prefers the tag name user over a Misskey id href', () => {
    const parts = noteToContent({
      content: '<p>@alice@misskey.example</p>',
      tag: [{ type: 'Mention', href: 'https://misskey.example/users/9abcdef', name: '@alice@misskey.example' }],
    })
    expect(mentions(parts)[0]).toMatchObject({ username: 'alice', domain: 'misskey.example', userId: 'https://misskey.example/users/9abcdef' })
  })
})

describe('outbound mentions of a subdomain user', () => {
  const author = { id: 'u1', username: 'owner', display_name: 'Owner', domain: 'har.mony.lol' } as any

  it('postToNote names and links the full handle', () => {
    const note = postToNote({
      id: 'p1', visibility: 'public', created_at: '',
      content: [{ type: 'text', text: 'hi ' }, { type: 'mention', username: 'doesnm', domain: SUB, isLocal: false }],
    }, author)
    expect(note.tag).toContainEqual({ type: 'Mention', href: HREF, name: `@doesnm@${SUB}` })
    expect(note.content).toContain(`>@doesnm@${SUB}</a>`)
  })

  it('postToNote does not name a local-host part as remote', () => {
    const note = postToNote({
      id: 'p1', visibility: 'public', created_at: '',
      content: [{ type: 'mention', username: 'alice', domain: 'har.mony.lol', isLocal: false }],
    }, author)
    expect(note.content).toContain('>@alice</a>')
  })

  it('contentUtils emits the full handle', () => {
    const parts = [{ type: 'mention', username: 'doesnm', domain: SUB, isLocal: false }]
    expect(convertContentToHTML(parts)).toContain(`href="${HREF}"`)
    expect(convertContentToHTML(parts)).toContain(`>@doesnm@${SUB}</a>`)
    expect(extractActivityPubTags(parts)).toContainEqual({ type: 'Mention', href: HREF, name: `@doesnm@${SUB}` })
  })

  it('round-trips through noteToContent', () => {
    const parts = [{ type: 'text', text: 'hi ' }, { type: 'mention', username: 'doesnm', domain: SUB, isLocal: false }, { type: 'text', text: '!' }]
    const back = noteToContent({ content: convertContentToHTML(parts), tag: extractActivityPubTags(parts) })
    expect(plain(back)).toBe(`hi <doesnm@${SUB}>!`)
  })
})

describe('normalizeInboundMentions (harmony:rawContent)', () => {
  it('gives a part without a host the sender host, never the local one', () => {
    const [m] = normalizeInboundMentions([{ type: 'mention', username: 'doesnm', isLocal: true }], SUB)
    expect(m).toMatchObject({ username: 'doesnm', domain: SUB, isLocal: false })
  })

  it('re-evaluates locality against this instance', () => {
    const out = normalizeInboundMentions([
      { type: 'mention', username: 'doesnm', domain: 'Chat.UnderStars.dev', isLocal: true },
      { type: 'mention', username: 'owner', domain: 'har.mony.lol', isLocal: false },
    ], SUB)
    expect(out[0]).toMatchObject({ domain: SUB, isLocal: false })
    expect(out[1]).toMatchObject({ domain: 'har.mony.lol', isLocal: true })
  })

  it('leaves bridged mentions alone', () => {
    const part = { type: 'mention', username: 'x', domain: 'discord.com', isLocal: false, isBridged: true }
    expect(normalizeInboundMentions([part], SUB)[0]).toEqual(part)
  })
})
