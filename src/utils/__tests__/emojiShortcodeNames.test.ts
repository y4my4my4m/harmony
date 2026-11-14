import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gemoji } from 'gemoji'
import { DISCORD_EMOJI_ALIASES } from '@/utils/discordEmojiAliases'

const data = JSON.parse(readFileSync(resolve(__dirname, '../../../public/assets/emojis/unicode-emoji-data.json'), 'utf8')) as {
  emojis: Array<{ unicode: string; shortcode: string }>
  lookups: { shortcodeToUnicode: Record<string, string>; unicodeToShortcode: Record<string, string> }
}
const names = data.lookups.shortcodeToUnicode
const withoutVs16 = (s: string) => s.replace(/️/g, '')

describe('shortcode names of the bundled emoji data', () => {
  it('gives every GitHub name the emoji GitHub gives it', () => {
    const wrong: string[] = []
    for (const g of gemoji) {
      for (const name of g.names) {
        if (withoutVs16(names[name] ?? '') !== withoutVs16(g.emoji)) wrong.push(`${name}: ${names[name]} for ${g.emoji}`)
      }
    }
    expect(wrong).toEqual([])
  })

  // The names a Unicode-derived shortcode of another emoji once held.
  it.each([
    ['sunglasses', '😎', 'dark_sunglasses', '🕶️'],
    ['kiss', '💋', 'couplekiss', '💏'],
    ['dog', '🐶', 'dog2', '🐕'],
    ['cat', '🐱', 'cat2', '🐈'],
    ['tiger', '🐯', 'tiger2', '🐅'],
    ['horse', '🐴', 'racehorse', '🐎'],
    ['cow', '🐮', 'cow2', '🐄'],
    ['pig', '🐷', 'pig2', '🐖'],
    ['camel', '🐫', 'dromedary_camel', '🐪'],
    ['mouse', '🐭', 'mouse2', '🐁'],
    ['rabbit', '🐰', 'rabbit2', '🐇'],
    ['whale', '🐳', 'whale2', '🐋'],
    ['post_office', '🏣', 'european_post_office', '🏤'],
    ['train', '🚋', 'train2', '🚆'],
    ['umbrella', '☔', 'open_umbrella', '☂️'],
    ['snowman', '⛄', 'snowman_with_snow', '☃️'],
    ['pencil', '📝', 'pencil2', '✏️'],
    ['calendar', '📆', 'date', '📅'],
    ['satellite', '📡', 'artificial_satellite', '🛰️'],
  ])(':%s: is %s and :%s: is %s', (name, emoji, otherName, otherEmoji) => {
    expect(withoutVs16(names[name])).toBe(withoutVs16(emoji))
    expect(withoutVs16(names[otherName])).toBe(withoutVs16(otherEmoji))
    expect(data.lookups.unicodeToShortcode[names[otherName]]).toBe(otherName)
  })

  it('maps each canonical shortcode back to its emoji', () => {
    for (const e of data.emojis) expect(names[e.shortcode]).toBe(e.unicode)
  })

  it('keeps Discord\'s own names for the emoji that gave a name up', () => {
    expect(DISCORD_EMOJI_ALIASES).toMatchObject({ umbrella2: '☂️', snowman2: '☃️', satellite_orbital: '🛰️' })
    for (const name of ['umbrella2', 'snowman2', 'satellite_orbital']) expect(names[name]).toBeUndefined()
  })
})
