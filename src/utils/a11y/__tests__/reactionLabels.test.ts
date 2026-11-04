import { describe, expect, it } from 'vitest'
import type { ReactionGroup } from '@/types'
import { reactionEmojiSpoken, reactionPillLabel, reactionsSummary, type EmojiResolver } from '../reactionLabels'

const MESSAGES: Record<string, string> = {
  'messageA11y.reactions.pill': '{emoji}, {count} reaction | {emoji}, {count} reactions',
  'messageA11y.reactions.pillYou': '{emoji}, {count} reaction, including you | {emoji}, {count} reactions, including you',
  'messageA11y.reactions.summary': 'Reactions: {list}',
}

/** vue-i18n's plural choice for en: the first form for 1, the second otherwise. */
const t = (key: string, params: Record<string, unknown>, plural?: number) => {
  const forms = (MESSAGES[key] ?? key).split(' | ')
  const form = forms.length > 1 && plural !== 1 ? forms[1] : forms[0]
  return form.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
}

const resolve: EmojiResolver = (identifier) => (identifier === '👍' ? { shortcode: 'thumbs_up' } : null)

const group = (fields: Partial<ReactionGroup> & { emoji: Record<string, unknown> }): ReactionGroup => ({
  emoji_id: 'e',
  count: 1,
  current_user_reacted: false,
  reactions: [],
  ...fields,
} as unknown as ReactionGroup)

const thumbs = group({ emoji_id: '👍', count: 2, current_user_reacted: true, emoji: { id: '👍', name: '👍', content: '👍' } })
const party = group({ emoji_id: 'c1', emoji: { id: 'c1', name: 'party_blob', url: 'https://emoji.example/party_blob.png' } })

describe('reaction labels', () => {
  it('names a Unicode emoji by its shortcode in words and a custom one by :name:, never its URL', () => {
    expect(reactionEmojiSpoken(thumbs, resolve)).toBe('thumbs up')
    expect(reactionEmojiSpoken(party, resolve)).toBe(':party_blob:')
  })

  it('falls back to the emoji when the resolver fails', () => {
    const throwing: EmojiResolver = () => { throw new Error('emoji data not loaded') }
    expect(reactionEmojiSpoken(thumbs, throwing)).toBe('👍')
  })

  it('builds the pill label with the count and whether the viewer reacted', () => {
    expect(reactionPillLabel(thumbs, t, resolve)).toBe('thumbs up, 2 reactions, including you')
    expect(reactionPillLabel(party, t, resolve)).toBe(':party_blob:, 1 reaction')
  })

  it('summarises a message\'s reactions as its pill labels in order; nothing without reactions', () => {
    expect(reactionsSummary([thumbs, party], t, resolve))
      .toBe('Reactions: thumbs up, 2 reactions, including you; :party_blob:, 1 reaction')
    expect(reactionsSummary([], t, resolve)).toBe('')
  })
})
