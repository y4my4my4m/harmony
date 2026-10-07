/**
 * Discord custom emoji token grammar, the emoji part it produces, and the
 * picker entries it is derived from.
 */
import { describe, it, expect } from 'vitest'
import {
  discordEmojiObject,
  discordEmojiPartText,
  discordEmojiRefFromPart,
  discordEmojiRefFromPicked,
  discordEmojiToken,
  parseDiscordEmojiToken,
} from '@/utils/discordEmoji'

const ID = '1376980620600672316'
const PNG = `https://cdn.discordapp.com/emojis/${ID}.png`
const GIF = `https://cdn.discordapp.com/emojis/${ID}.gif`

/** MessageTranslator.emojiText of harmony-discord-bridge 2.2, Harmony → Discord. */
function bridgeEmojiText(emoji: any): string {
  if (typeof emoji.content === 'string' && emoji.content) return emoji.content
  if (emoji.domain === 'discord.com' && typeof emoji.url === 'string') {
    const match = emoji.url.match(/emojis\/(\d+)\.(png|gif|webp)/)
    if (match) return `<${match[2] === 'gif' ? 'a' : ''}:${emoji.name}:${match[1]}>`
  }
  return `:${emoji.name}:`
}

describe('parseDiscordEmojiToken', () => {
  it('reads the static token, which is also the reaction identifier', () => {
    expect(parseDiscordEmojiToken(`discord:heh:${ID}`)).toEqual({ name: 'heh', id: ID, animated: false })
  })

  it('reads the animated token', () => {
    expect(parseDiscordEmojiToken(`discord:a:party_blob:${ID}`)).toEqual({ name: 'party_blob', id: ID, animated: true })
  })

  it('accepts names of 2 and 32 characters and ids of 17 and 20 digits', () => {
    expect(parseDiscordEmojiToken(`discord:ab:${'1'.repeat(17)}`)).not.toBeNull()
    expect(parseDiscordEmojiToken(`discord:${'n'.repeat(32)}:${'1'.repeat(20)}`)).not.toBeNull()
  })

  it.each([
    [`discord:h:${ID}`, 'one-character name'],
    [`discord:${'n'.repeat(33)}:${ID}`, '33-character name'],
    [`discord:he-h:${ID}`, 'hyphen in name'],
    [`discord:héh:${ID}`, 'non-ASCII name'],
    [`discord:heh:${'1'.repeat(16)}`, '16-digit id'],
    [`discord:heh:${'1'.repeat(21)}`, '21-digit id'],
    [`discord:heh:12a4567890123456789`, 'non-digit id'],
    [`discord:a:${ID}`, 'animated marker without a name'],
    [`discord:a:b:heh:${ID}`, 'extra segment'],
    [`heh:${ID}`, 'no prefix'],
    [`:discord:heh:${ID}:`, 'surrounding colons'],
  ])('rejects %s (%s)', (token) => {
    expect(parseDiscordEmojiToken(token)).toBeNull()
  })

  it('round-trips through discordEmojiToken', () => {
    for (const token of [`discord:heh:${ID}`, `discord:a:heh:${ID}`]) {
      expect(discordEmojiToken(parseDiscordEmojiToken(token)!)).toBe(token)
    }
  })
})

describe('discordEmojiObject', () => {
  it('has the shape the bridge writes for <:name:id>', () => {
    expect(discordEmojiObject({ name: 'heh', id: ID, animated: false })).toEqual({
      name: 'heh',
      url: PNG,
      id: null,
      domain: 'discord.com',
      display_name: 'heh',
      server_id: null,
    })
  })

  it('points an animated emoji at the .gif', () => {
    expect(discordEmojiObject({ name: 'heh', id: ID, animated: true }).url).toBe(GIF)
  })

  it('maps back to the Discord emoji in the bridge', () => {
    expect(bridgeEmojiText(discordEmojiObject({ name: 'heh', id: ID, animated: false }))).toBe(`<:heh:${ID}>`)
    expect(bridgeEmojiText(discordEmojiObject({ name: 'heh', id: ID, animated: true }))).toBe(`<a:heh:${ID}>`)
  })
})

describe('discordEmojiRefFromPicked', () => {
  // useFrequentEmojis entry recorded by MessageReactions from a bridged reaction chip.
  const recent = (url: string) => ({ id: `discord:heh:${ID}`, name: `discord:heh:${ID}`, url })

  it('reads a recent entry recorded from a bridged reaction', () => {
    expect(discordEmojiRefFromPicked(recent(PNG))).toEqual({ name: 'heh', id: ID, animated: false })
  })

  it('takes animation from a .gif url of the same emoji', () => {
    expect(discordEmojiRefFromPicked(recent(GIF))).toEqual({ name: 'heh', id: ID, animated: true })
    expect(discordEmojiRefFromPicked(recent(`https://media.discordapp.net/emojis/${ID}.webp?size=48&animated=true`))?.animated).toBe(true)
  })

  it('ignores a url of another emoji or another host', () => {
    expect(discordEmojiRefFromPicked(recent('https://cdn.discordapp.com/emojis/111111111111111111.gif'))?.animated).toBe(false)
    expect(discordEmojiRefFromPicked(recent(`https://cdn.discordapp.com.evil.example/emojis/${ID}.gif`))?.animated).toBe(false)
  })

  it('reads a bridged part emoji', () => {
    expect(discordEmojiRefFromPicked({ name: 'heh', url: GIF, id: null, domain: 'discord.com' })).toEqual({
      name: 'heh', id: ID, animated: true,
    })
  })

  it('is null for Harmony and unicode emoji', () => {
    expect(discordEmojiRefFromPicked({ id: '6f1c2a34-1111-4222-8333-444455556666', name: 'blobcat', url: 'https://harmony.test/e.png' })).toBeNull()
    expect(discordEmojiRefFromPicked({ id: '🎉', name: 'tada', url: '' })).toBeNull()
    expect(discordEmojiRefFromPicked({ id: 'discord', name: 'discord', url: '' })).toBeNull()
  })
})

describe('discordEmojiRefFromPart', () => {
  it('requires domain discord.com and a Discord CDN emoji url', () => {
    expect(discordEmojiRefFromPart({ name: 'heh', url: PNG, domain: 'discord.com' })).toEqual({ name: 'heh', id: ID, animated: false })
    expect(discordEmojiRefFromPart({ name: 'heh', url: `https://media.discordapp.net/emojis/${ID}.png?size=48`, domain: 'discord.com' })).not.toBeNull()
    expect(discordEmojiRefFromPart({ name: 'heh', url: PNG })).toBeNull()
    expect(discordEmojiRefFromPart({ name: 'heh', url: `http://cdn.discordapp.com/emojis/${ID}.png`, domain: 'discord.com' })).toBeNull()
    expect(discordEmojiRefFromPart({ name: 'heh', url: `https://evil.example/emojis/${ID}.png`, domain: 'discord.com' })).toBeNull()
    expect(discordEmojiRefFromPart({ name: 'h', url: PNG, domain: 'discord.com' })).toBeNull()
  })

  it('gives the composer token of a Discord part only', () => {
    expect(discordEmojiPartText({ name: 'heh', url: GIF, domain: 'discord.com' })).toBe(`:discord:a:heh:${ID}:`)
    expect(discordEmojiPartText({ name: 'blobcat', url: 'https://harmony.test/e.png', id: 'x' })).toBeNull()
  })
})
