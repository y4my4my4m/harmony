import { describe, expect, it } from 'vitest'
import { messagePartsToPlainText } from '../messageContentUtils'
import { cutRuns, messagePreviewRuns, runsText } from '../previewRuns'
import type { MessagePart } from '@/types'

const remote = { id: 'r1', name: 'pog', url: 'https://remote.example/media/pog.png' }
const local = { id: 'l1', name: 'wave', url: 'server/wave.webp' }
const text = (value: string) => ({ type: 'text', text: value }) as MessagePart
const emoji = (value: Record<string, unknown>) => ({ type: 'emoji', emoji: value }) as unknown as MessagePart

describe('messagePreviewRuns', () => {
  it('keeps custom emojis of this instance and of another between their text', () => {
    expect(messagePreviewRuns([text('alright, lets update guys '), emoji(remote), text(' and '), emoji(local)])).toEqual([
      { text: 'alright, lets update guys ', emoji: null },
      { text: '', emoji: { name: 'pog', url: remote.url } },
      { text: ' and ', emoji: null },
      { text: '', emoji: { name: 'wave', url: local.url } },
    ])
  })

  it('holds emojis alone, repeated, and more than ten of them in order', () => {
    const many = Array.from({ length: 12 }, (_, i) => emoji({ ...local, name: `e${i}`, url: `e${i}.png` }))
    expect(messagePreviewRuns(many).map((run) => run.emoji?.name)).toEqual(many.map((_, i) => `e${i}`))
    expect(messagePreviewRuns([emoji(remote), emoji(remote)])).toHaveLength(2)
  })

  it('names an emoji that has no address', () => {
    expect(messagePreviewRuns([text('a '), emoji({ id: 'x', name: 'gone' })])).toEqual([{ text: 'a :gone:', emoji: null }])
    expect(messagePreviewRuns([emoji({ id: 'x' }), text('b')])).toEqual([{ text: 'b', emoji: null }])
  })

  it('covers an emoji inside a spoiler with the spoiler', () => {
    const runs = messagePreviewRuns([text('look ||secret '), emoji(remote), text('|| and '), emoji(local)])
    expect(runs.map((run) => run.emoji?.name ?? run.text)).toEqual([expect.stringMatching(/^look ▒+ and $/), 'wave'])
    expect(messagePreviewRuns([text('||'), emoji(remote), text('||')])).toEqual([{ text: '▒▒▒', emoji: null }])
  })

  it('leaves a typed :name: and empty content as they are', () => {
    expect(messagePreviewRuns([text(':pog: is text')])).toEqual([{ text: ':pog: is text', emoji: null }])
    expect(messagePreviewRuns([])).toEqual([])
    expect(messagePreviewRuns(null as unknown as MessagePart[])).toEqual([])
  })
})

it('plain text still names custom emojis: copied text and reports hold no mark', () => {
  expect(messagePartsToPlainText([text('hi '), emoji(remote)])).toBe('hi :pog:')
})

describe('cutRuns and runsText', () => {
  const runs = messagePreviewRuns([text('abcde'), emoji(remote), text('fghij')])

  it('cuts inside a text and never through an emoji, which counts as one character', () => {
    expect(runsText(cutRuns(runs, 11))).toBe('abcde:pog:fghij')
    expect(runsText(cutRuns(runs, 8))).toBe('abcde:pog:fg…')
    expect(runsText(cutRuns(runs, 6))).toBe('abcde:pog:…')
    expect(runsText(cutRuns(runs, 5))).toBe('abcde…')
    expect(runsText(cutRuns(runs, 2))).toBe('ab…')
    expect(cutRuns([], 5)).toEqual([])
  })
})
