import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
  config: {
    INSTANCE_DOMAIN: 'harmony.test',
  },
}))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn((path: string) => ({
          data: { publicUrl: `http://localhost:54321/storage/v1/object/public/emojis/${path}` },
        })),
      })),
    },
  })),
}))
vi.mock('../utils/urlUtils.js', () => ({
  getFullAvatarUrl: vi.fn((url: string | null) => url || null),
  getFullBannerUrl: vi.fn((url: string | null) => url || null),
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  postToNote,
  messageToNote,
  profileToActor,
  createFollowActivity,
  createAcceptActivity,
  createLikeActivity,
  createAnnounceActivity,
  createDeleteActivity,
} from '../activitypub/converters/toActivityPub.js'
import {
  noteToContent,
  actorToProfile,
  extractFollowData,
  extractLikeData,
  normalizeObject,
  normalizeActor,
} from '../activitypub/converters/fromActivityPub.js'

// ============================================================================
// toActivityPub tests
// ============================================================================
describe('toActivityPub converters', () => {
  describe('postToNote', () => {
    const author = { username: 'alice' }

    it('generates correct Note structure for a public post', () => {
      const post = {
        id: 'post-123',
        content: [{ type: 'text', text: 'Hello fediverse!' }],
        visibility: 'public',
        created_at: '2025-01-01T00:00:00Z',
      }
      const note = postToNote(post, author)

      expect(note.type).toBe('Note')
      expect(note.id).toBe('https://harmony.test/posts/post-123')
      expect(note.attributedTo).toBe('https://harmony.test/users/alice')
      expect(note.content).toContain('Hello fediverse!')
      expect(note.to).toContain('https://www.w3.org/ns/activitystreams#Public')
      expect(note.cc).toContain('https://harmony.test/users/alice/followers')
    })

    it('sets audience correctly for unlisted visibility', () => {
      const post = { id: 'p1', content: 'hi', visibility: 'unlisted', created_at: '' }
      const note = postToNote(post, author)
      expect(note.to).toContain('https://harmony.test/users/alice/followers')
      expect(note.to).not.toContain('https://www.w3.org/ns/activitystreams#Public')
      expect(note.cc).toEqual([])
    })

    it('sets audience correctly for followers-only visibility', () => {
      const post = { id: 'p1', content: 'hi', visibility: 'followers', created_at: '' }
      const note = postToNote(post, author)
      expect(note.to).toContain('https://harmony.test/users/alice/followers')
      expect(note.cc).toEqual([])
    })

    it('sets empty audience for private/DM visibility', () => {
      const post = { id: 'p1', content: 'hi', visibility: 'private', created_at: '' }
      const note = postToNote(post, author)
      expect(note.to).toEqual([])
    })

    it('uses ap_id if available (federated post)', () => {
      const post = {
        id: 'local-id',
        ap_id: 'https://mastodon.social/users/bob/statuses/999',
        content: 'test',
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.id).toBe('https://mastodon.social/users/bob/statuses/999')
    })

    it('adds content_warning as summary', () => {
      const post = {
        id: 'p1',
        content: 'spoiler content',
        visibility: 'public',
        content_warning: 'Spoiler alert!',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.summary).toBe('Spoiler alert!')
    })

    it('adds sensitive flag', () => {
      const post = {
        id: 'p1',
        content: 'nsfw',
        visibility: 'public',
        is_sensitive: true,
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.sensitive).toBe(true)
    })

    it('extracts file attachments from content', () => {
      const post = {
        id: 'p1',
        content: [
          { type: 'text', text: 'Check this image' },
          { type: 'file', url: 'https://cdn.example.com/photo.jpg', fileType: 'image', mimeType: 'image/jpeg' },
        ],
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.attachment).toHaveLength(1)
      expect(note.attachment[0].type).toBe('Document')
      expect(note.attachment[0].mediaType).toBe('image/jpeg')
      expect(note.attachment[0].url).toBe('https://cdn.example.com/photo.jpg')
    })

    it('extracts mention tags from content', () => {
      const post = {
        id: 'p1',
        content: [
          { type: 'mention', username: 'bob', domain: 'mastodon.social', isLocal: false },
        ],
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.tag).toHaveLength(1)
      expect(note.tag[0].type).toBe('Mention')
      expect(note.tag[0].href).toBe('https://mastodon.social/users/bob')
      expect(note.tag[0].name).toBe('@bob@mastodon.social')
    })

    it('extracts hashtag tags from content', () => {
      const post = {
        id: 'p1',
        content: [{ type: 'hashtag', name: 'fediverse' }],
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.tag).toHaveLength(1)
      expect(note.tag[0].type).toBe('Hashtag')
      expect(note.tag[0].name).toBe('#fediverse')
    })

    it('adds quoteUrl and _misskey_quote for quote posts', () => {
      const post = { id: 'p1', content: 'quote', visibility: 'public', created_at: '' }
      const quoteUrl = 'https://mastodon.social/users/alice/statuses/123'
      const note = postToNote(post, author, quoteUrl)
      expect(note.quoteUrl).toBe(quoteUrl)
      expect(note._misskey_quote).toBe(quoteUrl)
    })

    it('escapes HTML in text content to prevent XSS', () => {
      const post = {
        id: 'p1',
        content: [{ type: 'text', text: '<script>alert("xss")</script>' }],
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.content).not.toContain('<script>')
      expect(note.content).toContain('&lt;script&gt;')
    })

    it('renders mentions as HTML links with correct href', () => {
      const post = {
        id: 'p1',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'mention', username: 'bob', domain: 'mastodon.social', isLocal: false },
        ],
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.content).toContain('<a href="https://mastodon.social/users/bob"')
      expect(note.content).toContain('@bob@mastodon.social')
    })

    it('renders local mentions without domain suffix', () => {
      const post = {
        id: 'p1',
        content: [
          { type: 'mention', username: 'charlie', isLocal: true },
        ],
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.content).toContain('@charlie')
      expect(note.content).not.toContain('@charlie@harmony.test')
    })

    it('infers MIME type from URL extension when not provided', () => {
      const post = {
        id: 'p1',
        content: [
          { type: 'file', url: 'https://cdn.example.com/video.mp4' },
        ],
        visibility: 'public',
        created_at: '',
      }
      const note = postToNote(post, author)
      expect(note.attachment[0].mediaType).toBe('video/mp4')
    })
  })

  describe('messageToNote', () => {
    it('creates a DM Note with empty to/cc', () => {
      const msg = { id: 'msg-1', content: [{ type: 'text', text: 'secret' }], created_at: '' }
      const author = { username: 'alice' }
      const note = messageToNote(msg, author)
      expect(note.type).toBe('Note')
      expect(note.to).toEqual([])
      expect(note.cc).toEqual([])
      expect(note.id).toBe('https://harmony.test/messages/msg-1')
    })
  })

  describe('profileToActor', () => {
    it('creates a valid Actor with all required fields', () => {
      const profile = {
        username: 'alice',
        display_name: 'Alice Wonderland',
        bio: 'Hello world',
        created_at: '2025-01-01T00:00:00Z',
        public_key: '-----BEGIN PUBLIC KEY-----\nMIIBI...\n-----END PUBLIC KEY-----',
      }
      const actor = profileToActor(profile)
      expect(actor.type).toBe('Person')
      expect(actor.id).toBe('https://harmony.test/users/alice')
      expect(actor.preferredUsername).toBe('alice')
      expect(actor.name).toBe('Alice Wonderland')
      expect(actor.inbox).toBe('https://harmony.test/users/alice/inbox')
      expect(actor.outbox).toBe('https://harmony.test/users/alice/outbox')
      expect(actor.followers).toBe('https://harmony.test/users/alice/followers')
      expect(actor.following).toBe('https://harmony.test/users/alice/following')
      expect(actor.publicKey.id).toBe('https://harmony.test/users/alice#main-key')
      expect(actor.publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY')
      expect(actor.endpoints.sharedInbox).toBe('https://harmony.test/inbox')
    })

    it('includes avatar as icon', () => {
      const profile = { username: 'alice', avatar_url: 'https://cdn.example.com/avatar.jpg' }
      const actor = profileToActor(profile)
      expect(actor.icon.type).toBe('Image')
      expect(actor.icon.url).toBe('https://cdn.example.com/avatar.jpg')
    })

    it('includes banner as image', () => {
      const profile = { username: 'alice', banner_url: 'https://cdn.example.com/banner.jpg' }
      const actor = profileToActor(profile)
      expect(actor.image.type).toBe('Image')
      expect(actor.image.url).toBe('https://cdn.example.com/banner.jpg')
    })

    it('omits icon when no avatar', () => {
      const actor = profileToActor({ username: 'alice' })
      expect(actor.icon).toBeUndefined()
    })

    it('includes profile fields as PropertyValue attachments', () => {
      const profile = {
        username: 'alice',
        profile_fields: [
          { name: 'Website', value: 'https://alice.example.com' },
          { name: 'Pronouns', value: 'she/her' },
        ],
      }
      const actor = profileToActor(profile)
      expect(actor.attachment).toHaveLength(2)
      expect(actor.attachment[0].type).toBe('PropertyValue')
      expect(actor.attachment[0].name).toBe('Website')
    })

    it('includes Harmony profile color extension', () => {
      const profile = { username: 'alice', color: '#ff5500' }
      const actor = profileToActor(profile)
      expect(actor['harmony:profileColor']).toBe('#ff5500')
    })
  })

  describe('createFollowActivity', () => {
    it('creates valid Follow activity', () => {
      const follower = { username: 'alice' }
      const following = { id: 'user-123', federated_id: 'https://mastodon.social/users/bob' }
      const activity = createFollowActivity(follower, following)
      expect(activity.type).toBe('Follow')
      expect(activity.actor).toBe('https://harmony.test/users/alice')
      expect(activity.object).toBe('https://mastodon.social/users/bob')
    })

    it('falls back to internal ID when no federated_id', () => {
      const follower = { username: 'alice' }
      const following = { id: 'user-123' }
      const activity = createFollowActivity(follower, following)
      expect(activity.object).toBe('user-123')
    })
  })

  describe('createAcceptActivity', () => {
    it('wraps the follow activity in Accept', () => {
      const actor = { username: 'bob' }
      const followActivity = { type: 'Follow', id: 'https://harmony.test/follows/1' }
      const accept = createAcceptActivity(actor, followActivity)
      expect(accept.type).toBe('Accept')
      expect(accept.actor).toBe('https://harmony.test/users/bob')
      expect(accept.object).toEqual(followActivity)
    })
  })

  describe('createLikeActivity', () => {
    it('creates basic Like with default heart', () => {
      const user = { username: 'alice' }
      const activity = createLikeActivity(user, 'https://mastodon.social/posts/1')
      expect(activity.type).toBe('Like')
      expect(activity.object).toBe('https://mastodon.social/posts/1')
      expect(activity.content).toBe('❤')
      expect(activity._misskey_reaction).toBe('❤')
    })

    it('includes Misskey-style emoji reaction', () => {
      const user = { username: 'alice' }
      const activity = createLikeActivity(user, 'https://example.com/posts/1', ':blobcat:', {
        name: 'blobcat',
        url: 'https://cdn.example.com/blobcat.png',
      })
      expect(activity.content).toBe(':blobcat:')
      expect(activity._misskey_reaction).toBe(':blobcat:')
      expect(activity.tag).toHaveLength(1)
      expect(activity.tag[0].type).toBe('Emoji')
    })
  })

  describe('createAnnounceActivity', () => {
    it('creates boost/reblog activity with public audience', () => {
      const user = { username: 'alice' }
      const activity = createAnnounceActivity(user, 'https://example.com/posts/1')
      expect(activity.type).toBe('Announce')
      expect(activity.to).toContain('https://www.w3.org/ns/activitystreams#Public')
      expect(activity.cc).toContain('https://harmony.test/users/alice/followers')
    })
  })

  describe('createDeleteActivity', () => {
    it('creates Delete activity', () => {
      const user = { username: 'alice' }
      const activity = createDeleteActivity(user, 'https://harmony.test/posts/1')
      expect(activity.type).toBe('Delete')
      expect(activity.actor).toBe('https://harmony.test/users/alice')
      expect(activity.object).toBe('https://harmony.test/posts/1')
    })
  })
})

// ============================================================================
// fromActivityPub tests
// ============================================================================
describe('fromActivityPub converters', () => {
  describe('noteToContent', () => {
    it('converts plain text HTML Note to MessagePart', () => {
      const note = { content: '<p>Hello world</p>' }
      const parts = noteToContent(note)
      expect(parts).toHaveLength(1)
      expect(parts[0].type).toBe('text')
      expect(parts[0].text).toBe('Hello world')
    })

    it('returns empty text for missing content', () => {
      const parts = noteToContent({})
      expect(parts).toEqual([{ type: 'text', text: '' }])
    })

    it('strips HTML tags from content', () => {
      const note = { content: '<p>Hello <strong>bold</strong> and <em>italic</em></p>' }
      const parts = noteToContent(note)
      const text = parts.map((p: any) => p.text || '').join('')
      expect(text).toContain('Hello')
      expect(text).toContain('bold')
      expect(text).not.toContain('<strong>')
    })

    it('unescapes HTML entities', () => {
      const note = { content: 'Tom &amp; Jerry &lt;3 &quot;quotes&quot;' }
      const parts = noteToContent(note)
      const text = parts.map((p: any) => p.text || '').join('')
      expect(text).toContain('Tom & Jerry')
      expect(text).toContain('<3')
      expect(text).toContain('"quotes"')
    })

    it('extracts mentions from tags into MessageParts', () => {
      const note = {
        content: '<p>Hello <a href="https://mastodon.social/users/bob">@bob@mastodon.social</a></p>',
        tag: [{
          type: 'Mention',
          href: 'https://mastodon.social/users/bob',
          name: '@bob@mastodon.social',
        }],
      }
      const parts = noteToContent(note)
      const mention = parts.find((p: any) => p.type === 'mention')
      expect(mention).toBeDefined()
      expect(mention.username).toBe('bob')
      expect(mention.domain).toBe('mastodon.social')
      expect(mention.isLocal).toBe(false)
    })

    it('marks local mentions as isLocal', () => {
      const note = {
        content: '<p>Hello @alice</p>',
        tag: [{
          type: 'Mention',
          href: 'https://harmony.test/users/alice',
          name: '@alice',
        }],
      }
      const parts = noteToContent(note)
      const mention = parts.find((p: any) => p.type === 'mention')
      expect(mention).toBeDefined()
      expect(mention.username).toBe('alice')
      expect(mention.isLocal).toBe(true)
    })

    it('extracts hashtags from tags', () => {
      const note = {
        content: '<p>#fediverse is great</p>',
        tag: [{ type: 'Hashtag', name: '#fediverse', href: 'https://example.com/tags/fediverse' }],
      }
      const parts = noteToContent(note)
      const hashtag = parts.find((p: any) => p.type === 'hashtag')
      expect(hashtag).toBeDefined()
      expect(hashtag.name).toBe('fediverse')
    })

    it('extracts custom emojis from tags', () => {
      const note = {
        content: '<p>I love :blobcat:</p>',
        tag: [{
          type: 'Emoji',
          name: ':blobcat:',
          icon: { url: 'https://cdn.example.com/emoji/blobcat.png' },
        }],
      }
      const parts = noteToContent(note)
      const emoji = parts.find((p: any) => p.type === 'emoji')
      expect(emoji).toBeDefined()
      expect(emoji.emoji.name).toBe('blobcat')
      expect(emoji.emoji.url).toBe('https://cdn.example.com/emoji/blobcat.png')
    })

    it('handles Misskey-style emojis object', () => {
      const note = {
        content: '<p>:blobfox:</p>',
        emojis: { blobfox: 'https://misskey.io/emoji/blobfox.webp' },
      }
      const parts = noteToContent(note)
      const emoji = parts.find((p: any) => p.type === 'emoji')
      expect(emoji).toBeDefined()
      expect(emoji.emoji.name).toBe('blobfox')
    })

    it('converts media attachments to file MessageParts', () => {
      const note = {
        content: '<p>Check this photo</p>',
        attachment: [{
          type: 'Document',
          mediaType: 'image/jpeg',
          url: 'https://cdn.mastodon.social/media/photo.jpg',
          name: 'A nice sunset',
          width: 1920,
          height: 1080,
        }],
      }
      const parts = noteToContent(note)
      const file = parts.find((p: any) => p.type === 'file')
      expect(file).toBeDefined()
      expect(file.fileType).toBe('image')
      expect(file.url).toBe('https://cdn.mastodon.social/media/photo.jpg')
      expect(file.altText).toBe('A nice sunset')
      expect(file.width).toBe(1920)
    })

    it('handles video attachments', () => {
      const note = {
        content: '<p>video</p>',
        attachment: [{ type: 'Document', mediaType: 'video/mp4', url: 'https://example.com/v.mp4' }],
      }
      const parts = noteToContent(note)
      const file = parts.find((p: any) => p.type === 'file')
      expect(file.fileType).toBe('video')
    })

    it('infers file type from URL extension when MIME is missing', () => {
      const note = {
        content: '<p>audio</p>',
        attachment: [{ type: 'Document', url: 'https://example.com/song.mp3' }],
      }
      const parts = noteToContent(note)
      const file = parts.find((p: any) => p.type === 'file')
      expect(file.fileType).toBe('audio')
    })

    it('handles a realistic Mastodon Note with mixed content', () => {
      const note = {
        content: '<p>Hello <span class="h-card"><a href="https://mastodon.social/@bob" class="u-url mention">@<span>bob</span></a></span> check out <a href="https://example.com" rel="nofollow noopener noreferrer" target="_blank"><span class="">https://example.com</span></a> #fediverse :blobcat:</p>',
        tag: [
          { type: 'Mention', href: 'https://mastodon.social/users/bob', name: '@bob@mastodon.social' },
          { type: 'Hashtag', href: 'https://mastodon.social/tags/fediverse', name: '#fediverse' },
          { type: 'Emoji', name: ':blobcat:', icon: { url: 'https://cdn.mastodon.social/emoji/blobcat.png' } },
        ],
      }
      const parts = noteToContent(note)
      expect(parts.length).toBeGreaterThanOrEqual(3)
      expect(parts.some((p: any) => p.type === 'mention')).toBe(true)
      expect(parts.some((p: any) => p.type === 'hashtag')).toBe(true)
      expect(parts.some((p: any) => p.type === 'emoji')).toBe(true)
    })
  })

  describe('actorToProfile', () => {
    it('extracts profile from a Mastodon-style Actor', () => {
      const actor = {
        id: 'https://mastodon.social/users/alice',
        type: 'Person',
        preferredUsername: 'alice',
        name: 'Alice',
        summary: '<p>Hello, I am Alice</p>',
        inbox: 'https://mastodon.social/users/alice/inbox',
        outbox: 'https://mastodon.social/users/alice/outbox',
        followers: 'https://mastodon.social/users/alice/followers',
        following: 'https://mastodon.social/users/alice/following',
        icon: { type: 'Image', url: 'https://cdn.mastodon.social/avatar.jpg' },
        image: { type: 'Image', url: 'https://cdn.mastodon.social/banner.jpg' },
        publicKey: {
          id: 'https://mastodon.social/users/alice#main-key',
          publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIBI...\n-----END PUBLIC KEY-----',
        },
        discoverable: true,
      }
      const profile = actorToProfile(actor)
      expect(profile.username).toBe('alice')
      expect(profile.domain).toBe('mastodon.social')
      expect(profile.display_name).toBe('Alice')
      expect(profile.bio).toBe('Hello, I am Alice')
      expect(profile.avatar).toBe('https://cdn.mastodon.social/avatar.jpg')
      expect(profile.banner).toBe('https://cdn.mastodon.social/banner.jpg')
      expect(profile.federated_id).toBe('https://mastodon.social/users/alice')
      expect(profile.inbox_url).toBe('https://mastodon.social/users/alice/inbox')
      expect(profile.public_key).toContain('BEGIN PUBLIC KEY')
      expect(profile.federation_discoverable).toBe(true)
    })

    it('strips HTML from bio but preserves newlines from <br>', () => {
      const actor = {
        id: 'https://example.com/users/bob',
        inbox: 'https://example.com/inbox',
        summary: '<p>Line 1<br/>Line 2</p><p>Line 3</p>',
      }
      const profile = actorToProfile(actor)
      expect(profile.bio).toContain('Line 1')
      expect(profile.bio).toContain('\n')
      expect(profile.bio).toContain('Line 2')
    })

    it('extracts PropertyValue attachments as profile fields', () => {
      const actor = {
        id: 'https://example.com/users/bob',
        inbox: 'https://example.com/inbox',
        attachment: [
          { type: 'PropertyValue', name: 'Website', value: '<a href="https://bob.dev">bob.dev</a>' },
          { type: 'PropertyValue', name: 'Pronouns', value: 'he/him' },
        ],
      }
      const profile = actorToProfile(actor)
      expect(profile.profile_fields).toHaveLength(2)
      expect(profile.profile_fields[0].name).toBe('Website')
    })

    it('extracts bio emojis from actor tags', () => {
      const actor = {
        id: 'https://example.com/users/bob',
        inbox: 'https://example.com/inbox',
        tag: [
          { type: 'Emoji', name: ':verified:', icon: { url: 'https://cdn.example.com/verified.png' } },
        ],
      }
      const profile = actorToProfile(actor)
      expect(profile.bio_emojis).toHaveLength(1)
      expect(profile.bio_emojis[0].name).toBe('verified')
    })

    it('handles Misskey-style emojis object on actor', () => {
      const actor = {
        id: 'https://misskey.io/users/test',
        inbox: 'https://misskey.io/inbox',
        emojis: { blobfox: 'https://misskey.io/emoji/blobfox.webp' },
      }
      const profile = actorToProfile(actor)
      expect(profile.bio_emojis).toHaveLength(1)
      expect(profile.bio_emojis[0].name).toBe('blobfox')
    })

    it('extracts Harmony extensions (color, custom_status)', () => {
      const actor = {
        id: 'https://harmony.test/users/alice',
        inbox: 'https://harmony.test/inbox',
        'harmony:profileColor': '#ff5500',
        'harmony:customStatus': { text: 'Coding', emoji: '💻' },
      }
      const profile = actorToProfile(actor)
      expect(profile.color).toBe('#ff5500')
      expect(profile.custom_status).toEqual({ text: 'Coding', emoji: '💻' })
    })
  })

  describe('extractFollowData', () => {
    it('extracts from string actor/object', () => {
      const activity = {
        id: 'https://example.com/follows/1',
        actor: 'https://example.com/users/alice',
        object: 'https://harmony.test/users/bob',
      }
      const data = extractFollowData(activity)
      expect(data.followerUrl).toBe('https://example.com/users/alice')
      expect(data.followingUrl).toBe('https://harmony.test/users/bob')
    })

    it('extracts from embedded actor/object', () => {
      const activity = {
        id: 'https://example.com/follows/1',
        actor: { id: 'https://example.com/users/alice' },
        object: { id: 'https://harmony.test/users/bob' },
      }
      const data = extractFollowData(activity)
      expect(data.followerUrl).toBe('https://example.com/users/alice')
      expect(data.followingUrl).toBe('https://harmony.test/users/bob')
    })
  })

  describe('extractLikeData', () => {
    it('extracts basic Like data', () => {
      const activity = {
        actor: 'https://example.com/users/alice',
        object: 'https://harmony.test/posts/1',
      }
      const data = extractLikeData(activity)
      expect(data.actorUrl).toBe('https://example.com/users/alice')
      expect(data.objectUrl).toBe('https://harmony.test/posts/1')
      expect(data.emoji).toBeUndefined()
    })

    it('extracts Misskey-style emoji reaction', () => {
      const activity = {
        actor: 'https://misskey.io/users/alice',
        object: 'https://harmony.test/posts/1',
        _misskey_reaction: ':blobcat:',
        tag: [{
          type: 'Emoji',
          name: ':blobcat:',
          icon: { url: 'https://misskey.io/emoji/blobcat.png' },
        }],
      }
      const data = extractLikeData(activity)
      expect(data.emoji).toBe(':blobcat:')
      expect(data.emojiUrl).toBe('https://misskey.io/emoji/blobcat.png')
    })
  })

  describe('normalizeObject / normalizeActor', () => {
    it('normalizes string to object with id', () => {
      expect(normalizeObject('https://example.com/object/1')).toEqual({ id: 'https://example.com/object/1' })
    })

    it('returns object as-is', () => {
      const obj = { id: 'x', type: 'Note' }
      expect(normalizeObject(obj)).toBe(obj)
    })

    it('normalizeActor returns string as-is', () => {
      expect(normalizeActor('https://example.com/users/alice')).toBe('https://example.com/users/alice')
    })

    it('normalizeActor extracts id from object', () => {
      expect(normalizeActor({ id: 'https://example.com/users/alice' })).toBe('https://example.com/users/alice')
    })
  })
})
