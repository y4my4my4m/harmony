import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { emojiSequenceRegex, hasEmojiSequence, isSingleEmojiSequence, splitEmojiSequences } from '@/utils/unicodeEmoji'

const SKIN = '👍🏽'
const FAMILY = '👨‍👩‍👧'
const FLAG = '🇯🇵'
const KEYCAP = '1️⃣'
const ENGLAND = '🏴󠁧󠁢󠁥󠁮󠁧󠁿'

const emojiRuns = (text: string) => splitEmojiSequences(text).filter((r) => r.emoji).map((r) => r.text)

describe('splitEmojiSequences', () => {
  it.each([
    ['', []],
    ['plain text, no emoji', []],
    [`a${SKIN}b`, [SKIN]],
    [`${FAMILY}${SKIN}${FLAG}`, [FAMILY, SKIN, FLAG]],
    ['🇯🇵🇺🇸', ['🇯🇵', '🇺🇸']],
    [`${KEYCAP} #⃣ *️⃣`, [KEYCAP, '#⃣', '*️⃣']],
    [ENGLAND, [ENGLAND]],
    ['❤️‍🔥 🏳️‍🌈 👁️‍🗨️', ['❤️‍🔥', '🏳️‍🌈', '👁️‍🗨️']],
    ['🧑🏻‍🤝‍🧑🏼', ['🧑🏻‍🤝‍🧑🏼']],
    ['☝🏽 ✌🏿', ['☝🏽', '✌🏿']],
    // Minimally qualified: the joined element lacks its VS16.
    ['🏃‍♂', ['🏃‍♂']],
    ['😀😀', ['😀', '😀']],
    ['日本語😀テキスト', ['😀']],
  ])('%j holds %j, and its runs join back to it', (text, expected) => {
    expect(emojiRuns(text)).toEqual(expected)
    expect(splitEmojiSequences(text).map((r) => r.text).join('')).toBe(text)
  })

  it.each([
    ['™ © ® ☺ ❤ ↔', 'text presentation by default'],
    ['⌚︎ ❤︎', 'VS15 asks for text'],
    ['0123456789 # *', 'keycap bases alone'],
    ['a‍b', 'ZWJ between letters'],
  ])('%j stays text: %s', (text) => {
    expect(emojiRuns(text)).toEqual([])
    expect(hasEmojiSequence(text)).toBe(false)
  })

  it('a text-presentation pictograph with VS16 is an emoji', () => {
    expect(emojiRuns('©️ ❤️ ☺️')).toEqual(['©️', '❤️', '☺️'])
  })

  it('round-trips text mixing every kind, byte for byte', () => {
    const text = `hi ${SKIN}\n**${FAMILY}** \`${FLAG}\` ${KEYCAP}${ENGLAND} ok ™ ❤︎ 🫠 end`
    const joined = splitEmojiSequences(text).map((r) => r.text).join('')
    expect(Buffer.from(joined).toString('hex')).toBe(Buffer.from(text).toString('hex'))
  })

  it('each regex is fresh: a global lastIndex does not leak between callers', () => {
    const a = emojiSequenceRegex()
    a.exec(`x${SKIN}`)
    expect(a.lastIndex).toBeGreaterThan(0)
    expect(emojiSequenceRegex().lastIndex).toBe(0)
    expect(emojiRuns(`x${SKIN}`)).toEqual([SKIN])
  })
})

describe('isSingleEmojiSequence', () => {
  it.each([SKIN, FAMILY, FLAG, KEYCAP, ENGLAND, '😀', '❤️'])('%j is one emoji', (text) => {
    expect(isSingleEmojiSequence(text)).toBe(true)
  })

  it.each(['😀😀', `${SKIN} `, 'a😀', '❤', ''])('%j is not', (text) => {
    expect(isSingleEmojiSequence(text)).toBe(false)
  })

  it('every emoji of the bundled emoji data is one sequence', () => {
    const data = JSON.parse(readFileSync(resolve(__dirname, '../../../public/assets/emojis/unicode-emoji-data.json'), 'utf8')) as {
      emojis: Array<{ unicode: string }>
    }
    expect(data.emojis.length).toBeGreaterThan(1800)
    expect(data.emojis.filter((e) => !isSingleEmojiSequence(e.unicode)).map((e) => e.unicode)).toEqual([])
  })
})
