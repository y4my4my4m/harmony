/**
 * The tooltip's label is text between colons: a default emoji's shortcode, a custom emoji's
 * name, never the emoji character itself. An optimistic default reaction carries the pack's
 * image url and is_native.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    resolveEmoji: (input: string) => input === '☝️' || input === 'index_pointing_up'
      ? { unicode: '☝️', shortcode: 'index_pointing_up', display: { type: 'svg', content: '/assets/twemoji/261d.svg' } }
      : { unicode: input, shortcode: null, display: { type: 'native', content: input } },
  }),
}))
vi.mock('@/components/common/Avatar.vue', () => ({ default: { template: '<span />' } }))
vi.mock('@/components/DisplayName.vue', () => ({ default: { props: ['fallback'], template: '<span>{{ fallback }}</span>' } }))

import ReactionTooltip from '../ReactionTooltip.vue'

const label = (emoji: Record<string, unknown>) =>
  mount(ReactionTooltip, { props: { visible: true, x: 0, y: 0, emoji, users: [] } }).find('.emoji-name')

describe('ReactionTooltip label', () => {
  it('names an optimistic default reaction by its shortcode', () => {
    expect(label({ name: '☝️', content: '☝️', url: '/assets/twemoji/261d.svg', is_native: true }).text()).toBe(':index_pointing_up:')
  })

  it('names the stored default reaction the same way', () => {
    expect(label({ name: 'index_pointing_up', content: 'index_pointing_up' }).text()).toBe(':index_pointing_up:')
  })

  it('names a custom emoji by its name', () => {
    expect(label({ name: 'party_parrot', url: 'https://x.test/p.gif' }).text()).toBe(':party_parrot:')
  })

  it('shows no label rather than a character between colons', () => {
    expect(label({ name: '🫠', content: '🫠' }).exists()).toBe(false)
  })
})
