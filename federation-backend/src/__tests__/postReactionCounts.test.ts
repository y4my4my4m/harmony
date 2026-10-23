import { describe, it, expect, vi } from 'vitest'

// harmony:reactions as a reader takes it: entries a Note carries become remote_reactions keyed
// as the app's chips key them; anything malformed or hostile is dropped.

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: vi.fn() }))
vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'harmony.test' }, config: { INSTANCE_DOMAIN: 'harmony.test' } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { remoteReactionsFromNote, withReactionCounts } = await import('../activitypub/postReactionCounts.js')

const emoji = (name: string, url: unknown) => ({ type: 'Emoji', name, icon: { type: 'Image', url } })

describe('remoteReactionsFromNote', () => {
  it('is null for a Note without counts, so the likes collection applies', () => {
    expect(remoteReactionsFromNote({ type: 'Note' })).toBeNull()
    expect(remoteReactionsFromNote({ 'harmony:reactions': 'many' })).toBeNull()
    expect(remoteReactionsFromNote(null)).toBeNull()
  })

  it('keys unicode by the emoji and image emojis by the bare shortcode', () => {
    expect(remoteReactionsFromNote({
      'harmony:reactions': [
        { content: '🔥', count: 2 },
        { content: ':blob@remote.test:', count: 1, tag: emoji(':blob:', 'https://remote.test/e/blob.png') },
      ],
    })).toEqual({
      '🔥': { count: 2, reactors: [] },
      ':blob:': { count: 1, url: 'https://remote.test/e/blob.png', reactors: [] },
    })
  })

  it('drops hearts, untagged shortcodes, unsafe icons, bad counts and oversized content', () => {
    expect(remoteReactionsFromNote({
      'harmony:reactions': [
        { content: '❤', count: 1 },
        { content: '♥️', count: 1 },
        { content: ':bare:', count: 1 },
        { content: ':js:', count: 1, tag: emoji(':js:', 'javascript:alert(1)') },
        { content: ':data:', count: 1, tag: emoji(':data:', 'data:image/png;base64,AAAA') },
        { content: '👀', count: 1.5 },
        { content: '👀', count: -1 },
        { content: '👀', count: '3' },
        { content: 'x'.repeat(129), count: 1 },
        null,
        'string',
      ],
    })).toEqual({})
  })

  it('keeps at most 64 entries', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({ content: String.fromCodePoint(0x1f600 + i), count: 1 }))
    expect(Object.keys(remoteReactionsFromNote({ 'harmony:reactions': entries })!)).toHaveLength(64)
  })
})

describe('withReactionCounts', () => {
  it('adds the counts and the harmony term', () => {
    const terms = { toot: 'http://joinmastodon.org/ns#' }
    const note = { '@context': ['https://www.w3.org/ns/activitystreams', terms], type: 'Note' }
    const out: Record<string, any> = withReactionCounts(note, [{ content: '🔥', count: 1 }])
    expect(out['harmony:reactions']).toEqual([{ content: '🔥', count: 1 }])
    expect((out['@context'] as any)[1].harmony).toBe('https://mony.lol/ns#')
  })
})
