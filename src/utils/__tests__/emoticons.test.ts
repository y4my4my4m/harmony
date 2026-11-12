import { describe, it, expect } from 'vitest'
import { convertEmoticons, EMOTICONS } from '@/utils/emoticons'

describe('convertEmoticons table', () => {
  const table: Array<[string, string]> = [
    [':D', '😄'],
    [':)', '🙂'],
    [':(', '😦'],
    [';)', '😉'],
    [':P', '😛'],
    [':p', '😛'],
    ['<3', '❤️'],
    [':O', '😮'],
    [':o', '😮'],
    [":'(", '😢'],
    ['xD', '😆'],
    ['XD', '😆'],
    [':|', '😐'],
    [':/', '😕'],
    [':-)', '🙂'],
    ['</3', '💔'],
    // Discord's table
    [":')", '🥲'],
    [":'-)", '🥲'],
    [':,)', '🥲'],
    [":'D", '😂'],
    ['=D', '😄'],
    ['=)', '🙂'],
    ['=P', '😛'],
    [':-P', '😛'],
    ['8-)', '😎'],
    ['B-)', '😎'],
    ['O:)', '😇'],
    ['0:-)', '😇'],
    [']:)', '😈'],
    [']:(', '👿'],
    [',:)', '😅'],
    [',:(', '😓'],
    [';(', '😭'],
    [":,'(", '😭'],
    [':*', '😗'],
    [':")', '😊'],
    [':s', '😒'],
    [':-S', '😒'],
    [':$', '😒'],
    ['x-)', '😆'],
    [':-\\', '😕'],
    ['<\\3', '💔'],
    ['♡', '❤️'],
    [':@', '😡'],
    ['=-@', '😡'],
  ]

  it.each(table)('%s -> %s', (emoticon, emoji) => {
    expect(convertEmoticons(emoticon)).toBe(emoji)
    expect(convertEmoticons(`hi ${emoticon}`)).toBe(`hi ${emoji}`)
    expect(convertEmoticons(`${emoticon} hi`)).toBe(`${emoji} hi`)
    expect(convertEmoticons(`hi ${emoticon}!`)).toBe(`hi ${emoji}!`)
    expect(convertEmoticons(`"${emoticon}"`)).toBe(`"${emoji}"`)
    expect(convertEmoticons(`a\n${emoticon}\nb`)).toBe(`a\n${emoji}\nb`)
  })

  it('covers every exported emoticon', () => {
    for (const [emoticon, emoji] of EMOTICONS) expect(convertEmoticons(`a ${emoticon}`)).toBe(`a ${emoji}`)
  })

  it('holds Discord\'s 128 emoticons and the 5 additions, each once', () => {
    expect(EMOTICONS).toHaveLength(133)
    expect(new Set(EMOTICONS.map(([emoticon]) => emoticon)).size).toBe(133)
  })

  it('converts an angry face mid-line', () => {
    expect(convertEmoticons('ugh >:(')).toBe('ugh 😠')
    expect(convertEmoticons('a\nugh >=-( b')).toBe('a\nugh 😠 b')
  })

  it('converts several in one message', () => {
    expect(convertEmoticons('ok :) see you <3 xD')).toBe('ok 🙂 see you ❤️ 😆')
  })

  it('converts inside parentheses', () => {
    expect(convertEmoticons('(xD) (:D) (<3)')).toBe('(😆) (😄) (❤️)')
  })

  it('converts inside markdown emphasis', () => {
    expect(convertEmoticons('*:D*')).toBe('*😄*')
  })
})

describe('convertEmoticons negatives', () => {
  it.each([
    ['URL scheme', 'see http://example.com/a:/b', 'see http://example.com/a:/b'],
    ['bare URL path', 'https://x.test/:D', 'https://x.test/:D'],
    ['www link', 'www.example.com/:P', 'www.example.com/:P'],
    ['email', 'mail me at bob:)@example.com', 'mail me at bob:)@example.com'],
    ['mention', '@alice:D hi', '@alice:D hi'],
    ['time', 'meet at 12:30 or 10:00', 'meet at 12:30 or 10:00'],
    ['time with o', 'at 10:o5', 'at 10:o5'],
    ['inside word', 'foo:Dbar and std::Path', 'foo:Dbar and std::Path'],
    ['xD inside word', 'xDD boxD xDebug', 'xDD boxD xDebug'],
    ['heart in comparison', 'i<3 and 1 <30', 'i<3 and 1 <30'],
    ['double paren', 'hi :)) and :((', 'hi :)) and :(('],
    ['inline code', 'type `:)` to smile', 'type `:)` to smile'],
    ['fenced code', '```\nconst x = a ? :) : <3\n```', '```\nconst x = a ? :) : <3\n```'],
    ['unterminated fence', '```js\n:) <3', '```js\n:) <3'],
    ['shortcode', ':D: and :p:', ':D: and :p:'],
    ['greentext angry face', '>:(', '>:('],
    ['greentext angry face on a later line', 'a\n>:-( b', 'a\n>:-( b'],
    ['uppercase S', ':S and =S', ':S and =S'],
    ['kiss before bold', ':**bold**', ':**bold**'],
    ['email with an emoticon tail', 'bob:@example.com', 'bob:@example.com'],
    ['equals in an expression', 'x=D and a=)b', 'x=D and a=)b'],
    ['digit before a nose', '18-) 1B-)', '18-) 1B-)'],
    ['lowercase xd', 'xd', 'xd'],
  ])('%s', (_label, input, expected) => {
    expect(convertEmoticons(input)).toBe(expected)
  })

  it('converts outside code while leaving the code span alone', () => {
    expect(convertEmoticons(':) `:)` :)')).toBe('🙂 `:)` 🙂')
    expect(convertEmoticons('```\n:)\n```\n:)')).toBe('```\n:)\n```\n🙂')
  })

  it('converts next to a URL separated by whitespace', () => {
    expect(convertEmoticons('https://example.com :)')).toBe('https://example.com 🙂')
  })

  it('returns text without candidates unchanged', () => {
    const s = 'plain words only'
    expect(convertEmoticons(s)).toBe(s)
    expect(convertEmoticons('')).toBe('')
  })
})
