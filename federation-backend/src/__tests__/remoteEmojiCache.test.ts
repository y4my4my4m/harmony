import { describe, it, expect, vi, beforeEach } from 'vitest'

// Emoji tags of a stored inbound note recorded in remote_emojis_cache with their licence.

const cfg = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' }))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { cacheInboundEmojiTags, remoteEmojiSightings, MAX_EMOJI_TAGS } = await import('../utils/remoteEmojiCache.js')

const ACTOR = 'https://misskey.test/users/9abc'
const emoji = (name: string, url: string, extra: Record<string, unknown> = {}) => ({
  type: 'Emoji', name, icon: { type: 'Image', mediaType: 'image/png', url }, ...extra,
})

describe('remoteEmojiSightings', () => {
  it('reads shortcode, origin, image and Misskey licence', () => {
    const tags = [
      { type: 'Mention', name: '@ann@harmony.test', href: 'https://harmony.test/users/ann' },
      emoji(':blobcat:', 'https://media.misskey.test/blobcat.png', { _misskey_license: { freeText: '  CC BY 4.0, Artist  ' } }),
      emoji(':plain:', 'https://media.misskey.test/plain.png'),
    ]
    expect(remoteEmojiSightings(tags, ACTOR)).toEqual([
      { shortcode: 'blobcat', domain: 'misskey.test', url: 'https://media.misskey.test/blobcat.png', license: 'CC BY 4.0, Artist' },
      { shortcode: 'plain', domain: 'misskey.test', url: 'https://media.misskey.test/plain.png', license: null },
    ])
  })

  it('takes the origin from the actor, never from the image host', () => {
    const [sighting] = remoteEmojiSightings([emoji(':cdn:', 'https://cdn.example/e.png')], ACTOR)
    expect(sighting.domain).toBe('misskey.test')
  })

  it('accepts a shortcode qualified with the sender and Misskey\'s own-instance form', () => {
    const tags = [emoji(':a@misskey.test:', 'https://misskey.test/a.png'), emoji(':b@.:', 'https://misskey.test/b.png')]
    expect(remoteEmojiSightings(tags, ACTOR).map((s) => `${s.shortcode}@${s.domain}`)).toEqual(['a@misskey.test', 'b@misskey.test'])
  })

  it('skips an emoji of another instance and one of this instance echoed back', () => {
    const tags = [emoji(':theirs@other.test:', 'https://other.test/t.png'), emoji(':ours@harmony.test:', 'https://db.harmony.test/o.png')]
    expect(remoteEmojiSightings(tags, ACTOR)).toEqual([])
  })

  it('skips tags without an http(s) image, with a bad name, and repeats', () => {
    const tags = [
      emoji(':data:', 'data:image/png;base64,AAAA'),
      emoji(':two words:', 'https://misskey.test/x.png'),
      { type: 'Emoji', name: ':noicon:' },
      emoji(':dup:', 'https://misskey.test/1.png'),
      emoji(':dup:', 'https://misskey.test/2.png'),
      emoji(':listed:', 'unused', { icon: [{ type: 'Image', url: 'https://misskey.test/l.png' }] }),
      emoji(':bare:', 'unused', { icon: 'https://misskey.test/bare.png' }),
    ]
    expect(remoteEmojiSightings(tags, ACTOR).map((s) => `${s.shortcode} ${s.url}`)).toEqual([
      'dup https://misskey.test/1.png', 'listed https://misskey.test/l.png', 'bare https://misskey.test/bare.png',
    ])
  })

  it('cuts a licence to 1024 characters, drops a blank or non-string one, and caps the tags read', () => {
    const long = remoteEmojiSightings([emoji(':long:', 'https://misskey.test/l.png', { _misskey_license: { freeText: 'x'.repeat(3000) } })], ACTOR)
    expect(long[0].license).toHaveLength(1024)
    const blank = remoteEmojiSightings([emoji(':blank:', 'https://misskey.test/b.png', { _misskey_license: { freeText: '   ' } })], ACTOR)
    expect(blank[0].license).toBeNull()
    const odd = remoteEmojiSightings([emoji(':odd:', 'https://misskey.test/o.png', { _misskey_license: { freeText: 7 } })], ACTOR)
    expect(odd[0].license).toBeNull()
    const many = Array.from({ length: MAX_EMOJI_TAGS + 20 }, (_, i) => emoji(`:e${i}:`, `https://misskey.test/${i}.png`))
    expect(remoteEmojiSightings(many, ACTOR)).toHaveLength(MAX_EMOJI_TAGS)
  })

  it('reads nothing without an actor or tags', () => {
    expect(remoteEmojiSightings([emoji(':a:', 'https://misskey.test/a.png')], null)).toEqual([])
    expect(remoteEmojiSightings(undefined, ACTOR)).toEqual([])
    expect(remoteEmojiSightings(emoji(':single:', 'https://misskey.test/s.png'), ACTOR)).toHaveLength(1)
  })
})

describe('cacheInboundEmojiTags', () => {
  const rpc = vi.fn()
  beforeEach(() => {
    rpc.mockReset()
    rpc.mockResolvedValue({ data: 'id', error: null })
  })

  it('upserts each emoji, with p_license only when the origin sent one', async () => {
    await cacheInboundEmojiTags({ rpc }, [
      emoji(':blobcat:', 'https://media.misskey.test/blobcat.png', { _misskey_license: { freeText: 'CC0' } }),
      emoji(':plain:', 'https://media.misskey.test/plain.png'),
    ], ACTOR)
    expect(rpc.mock.calls).toEqual([
      ['upsert_remote_emoji', {
        p_shortcode: 'blobcat', p_origin_domain: 'misskey.test', p_full_code: ':blobcat@misskey.test:',
        p_url: 'https://media.misskey.test/blobcat.png', p_license: 'CC0',
      }],
      ['upsert_remote_emoji', {
        p_shortcode: 'plain', p_origin_domain: 'misskey.test', p_full_code: ':plain@misskey.test:',
        p_url: 'https://media.misskey.test/plain.png',
      }],
    ])
  })

  it('never throws: a refused or failing write is skipped', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'PGRST202' } }).mockRejectedValueOnce(new Error('down'))
    await expect(cacheInboundEmojiTags({ rpc }, [
      emoji(':a:', 'https://misskey.test/a.png'), emoji(':b:', 'https://misskey.test/b.png'), emoji(':c:', 'https://misskey.test/c.png'),
    ], ACTOR)).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledTimes(3)
    await expect(cacheInboundEmojiTags({ rpc: undefined }, [emoji(':a:', 'https://misskey.test/a.png')], ACTOR)).resolves.toBeUndefined()
  })
})
