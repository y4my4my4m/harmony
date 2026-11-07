import { describe, it, expect } from 'vitest'
import { inboundEmojiOrigin } from '../utils/emojiOrigin.js'

describe('inboundEmojiOrigin', () => {
  it('takes the origin from a qualified shortcode, not the image host', () => {
    expect(inboundEmojiOrigin(':eyes@har.mony.lol:', 'https://har.mony.lol/users/y4my4m'))
      .toEqual({ name: 'eyes', domain: 'har.mony.lol' })
  })

  it('keeps a third instance named in the shortcode', () => {
    expect(inboundEmojiOrigin(':blob@misskey.example:', 'https://har.mony.lol/users/a'))
      .toEqual({ name: 'blob', domain: 'misskey.example' })
  })

  it("gives an unqualified shortcode the sender's instance", () => {
    expect(inboundEmojiOrigin(':blobcat:', 'https://mastodon.example/users/bob'))
      .toEqual({ name: 'blobcat', domain: 'mastodon.example' })
  })

  it("reads Misskey's name@. as the sender's own", () => {
    expect(inboundEmojiOrigin(':party@.:', 'https://misskey.example/users/9abc'))
      .toEqual({ name: 'party', domain: 'misskey.example' })
  })

  it('leaves an @ that names no host in the shortcode', () => {
    expect(inboundEmojiOrigin(':a@b:', 'https://x.example/users/c'))
      .toEqual({ name: 'a@b', domain: 'x.example' })
  })

  it('has no domain without a parseable actor', () => {
    expect(inboundEmojiOrigin('wave', 'not a url')).toEqual({ name: 'wave', domain: null })
  })
})
