/**
 * What an emoji info card is about: a part's custom emoji by id or url, a Discord emoji, a
 * unicode emoji by its shortcode. A default reaction is named by its shortcode, optimistic
 * or stored, never by the character between colons.
 */
import { describe, expect, it } from 'vitest'
import {
  emojiInfoCopyText,
  emojiInfoName,
  emojiInfoTargetFromElement,
  emojiInfoTargetFromPart,
  emojiInfoTargetFromReaction,
  isUnicodeEmoji,
  type EmojiResolver,
} from '@/utils/emojiInfoTarget'

const ID = '11111111-2222-4333-8444-555555555555'

const resolve: EmojiResolver = (input) => {
  if (input === '☝️' || input === 'index_pointing_up') {
    return { unicode: '☝️', shortcode: 'index_pointing_up', imageUrl: '/assets/twemoji/261d.svg' }
  }
  if (input === '🧹' || input === 'broom') return { unicode: '🧹', shortcode: 'broom', imageUrl: null }
  return { unicode: input, shortcode: null, imageUrl: null }
}

describe('emojiInfoTargetFromPart', () => {
  it('asks by id for an emojis row', () => {
    expect(emojiInfoTargetFromPart({ id: ID, name: 'catyes', url: 'https://cdn.test/c.png' }))
      .toEqual({ kind: 'custom', id: ID, name: 'catyes', url: 'https://cdn.test/c.png' })
  })

  it('asks by url for a federated part, with the image host as a hint', () => {
    expect(emojiInfoTargetFromPart({ id: 'remote:blob', name: 'blob', url: 'https://fedi.example/e/blob.png' }, 'here.test'))
      .toEqual({ kind: 'custom', id: null, name: 'blob', url: 'https://fedi.example/e/blob.png', remoteHost: 'fedi.example' })
  })

  it('gives no host hint for an image this instance serves', () => {
    const target = emojiInfoTargetFromPart({ id: 'remote:blob', name: 'blob', url: 'https://here.test/e/blob.png' }, 'here.test')
    expect(target).toMatchObject({ kind: 'custom', id: null, remoteHost: null })
  })

  it('gives no host hint for a non-federated part without an id', () => {
    const target = emojiInfoTargetFromPart({ id: 'whatever', name: 'x', url: 'https://other.test/x.png' }, 'here.test')
    expect(target).toMatchObject({ kind: 'custom', id: null, remoteHost: null })
  })

  it('recognises a bridged Discord emoji', () => {
    const target = emojiInfoTargetFromPart({ name: 'peepo', url: 'https://cdn.discordapp.com/emojis/123456789012345678.png', domain: 'discord.com', id: null })
    expect(target).toEqual({
      kind: 'discord',
      name: 'peepo',
      url: 'https://cdn.discordapp.com/emojis/123456789012345678.png',
      token: ':discord:peepo:123456789012345678:',
    })
  })

  it('refuses a part without a name or url', () => {
    expect(emojiInfoTargetFromPart({ id: ID, name: '', url: 'x' })).toBeNull()
    expect(emojiInfoTargetFromPart({ id: ID, name: 'x', url: '' })).toBeNull()
    expect(emojiInfoTargetFromPart(null)).toBeNull()
  })
})

describe('emojiInfoTargetFromReaction', () => {
  it('names an optimistic default reaction by its shortcode', () => {
    const target = emojiInfoTargetFromReaction(
      { emoji_id: null, emoji: { name: '☝️', content: '☝️', url: '/assets/twemoji/261d.svg', is_native: true } },
      resolve,
    )
    expect(target).toEqual({ kind: 'default', glyph: '☝️', shortcode: 'index_pointing_up', imageUrl: '/assets/twemoji/261d.svg' })
    expect(emojiInfoName(target!)).toBe('index_pointing_up')
  })

  it('names the stored default reaction the same way', () => {
    const target = emojiInfoTargetFromReaction({ emoji_id: null, emoji: { name: 'index_pointing_up', content: 'index_pointing_up' } }, resolve)
    expect(target).toMatchObject({ kind: 'default', glyph: '☝️', shortcode: 'index_pointing_up' })
  })

  it('has no name for a default emoji without a shortcode, not the character', () => {
    const target = emojiInfoTargetFromReaction({ emoji_id: null, emoji: { name: '🫠', content: '🫠' } }, resolve)
    expect(target).toMatchObject({ kind: 'default', glyph: '🫠', shortcode: null })
    expect(emojiInfoName(target!)).toBeNull()
  })

  it('takes a custom reaction by its emoji_id', () => {
    expect(emojiInfoTargetFromReaction({ emoji_id: ID, emoji: { id: ID, name: 'party_parrot', url: 'https://x.test/p.gif' } }, resolve))
      .toEqual({ kind: 'custom', id: ID, name: 'party_parrot', url: 'https://x.test/p.gif' })
  })

  it('takes a Discord reaction by its identifier', () => {
    const target = emojiInfoTargetFromReaction(
      { emoji_id: null, emoji: { id: 'discord:peepo:123456789012345678', name: 'peepo', url: 'https://cdn.discordapp.com/emojis/123456789012345678.png' } },
      resolve,
    )
    expect(target).toMatchObject({ kind: 'discord', name: 'peepo', token: ':discord:peepo:123456789012345678:' })
  })

  it('asks by url for a custom reaction without an emojis id', () => {
    expect(emojiInfoTargetFromReaction({ emoji_id: null, emoji: { id: 'blob@fedi.example', name: 'blob', url: 'https://fedi.example/b.png' } }, resolve))
      .toMatchObject({ kind: 'custom', id: null, name: 'blob' })
  })
})

describe('emojiInfoTargetFromElement', () => {
  it('reads a twemoji image by its alt', () => {
    const img = document.createElement('img')
    img.className = 'inline-emoji'
    img.setAttribute('alt', '🧹')
    expect(emojiInfoTargetFromElement(img, resolve)).toEqual({ kind: 'default', glyph: '🧹', shortcode: 'broom', imageUrl: null })
  })

  it('reads a native emoji span by its text', () => {
    const span = document.createElement('span')
    span.className = 'native-emoji single'
    span.textContent = '🧹'
    expect(emojiInfoTargetFromElement(span, resolve)).toMatchObject({ kind: 'default', glyph: '🧹' })
  })

  it('refuses text that is not an emoji', () => {
    const img = document.createElement('img')
    img.setAttribute('alt', ':custom:')
    expect(emojiInfoTargetFromElement(img, resolve)).toBeNull()
    expect(isUnicodeEmoji('12')).toBe(false)
  })
})

describe('emojiInfoCopyText', () => {
  it('copies the glyph, the composer token, or the Discord token', () => {
    expect(emojiInfoCopyText({ kind: 'default', glyph: '🧹', shortcode: 'broom', imageUrl: null })).toBe('🧹')
    expect(emojiInfoCopyText({ kind: 'custom', id: ID, name: 'catyes', url: 'u' })).toBe(':catyes:')
    expect(emojiInfoCopyText({ kind: 'discord', name: 'peepo', url: 'u', token: ':discord:peepo:1:' })).toBe(':discord:peepo:1:')
  })
})
