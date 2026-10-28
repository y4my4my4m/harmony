import { describe, expect, it, vi } from 'vitest'

// Inbound emoji parts lose the sending instance's emojis.id: a foreign uuid names no row here,
// or another emoji's, which the emoji info card would credit.

vi.mock('../../config/index.js', () => {
  const cfg = {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://kong:8000',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  }
  return { default: cfg, config: cfg }
})
vi.mock('../../config/supabase.js', () => ({ getSupabaseClient: vi.fn(() => ({})) }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { inboundRawContent, urlFormEmojis, withRemoteEmojiIds } from '../inboundContent.js'
import { noteToContent } from '../../activitypub/converters/fromActivityPub.js'

const FOREIGN = '0b5e2a4e-1111-4222-8333-444455556666'
const emoji = (id: unknown, name = 'blobcat') => ({ type: 'emoji', emoji: { id, name, url: `https://peer.test/e/${name}.png` } })

describe('withRemoteEmojiIds', () => {
  it('replaces a uuid with remote:<name>', () => {
    expect(withRemoteEmojiIds([emoji(FOREIGN), emoji(FOREIGN.toUpperCase(), ':party:')])).toEqual([
      { type: 'emoji', emoji: { id: 'remote:blobcat', name: 'blobcat', url: 'https://peer.test/e/blobcat.png' } },
      { type: 'emoji', emoji: { id: 'remote:party', name: ':party:', url: 'https://peer.test/e/:party:.png' } },
    ])
  })

  it('keeps IRIs, remote: forms, a Discord emoji without id and other parts', () => {
    const kept = [
      emoji('https://peer.test/emojis/1'),
      emoji('remote:blobcat'),
      { type: 'emoji', emoji: { id: null, name: 'pog', url: 'https://cdn.discordapp.com/emojis/1.png', domain: 'discord.com' } },
      { type: 'text', text: FOREIGN },
    ]
    expect(withRemoteEmojiIds(kept)).toEqual(kept)
  })

  it('runs in the rawContent path', () => {
    expect(inboundRawContent([{ type: 'text', text: 'hi ' }, emoji(FOREIGN)], 'peer.test')[1])
      .toMatchObject({ emoji: { id: 'remote:blobcat' } })
  })
})

describe('urlFormEmojis', () => {
  it('writes channel emoji in the URL form with remote:<name> and the sender\'s domain', () => {
    expect(urlFormEmojis([emoji(FOREIGN), { type: 'text', text: 'x' }], 'peer.test')).toEqual([
      { type: 'emoji', emoji: { id: 'remote:blobcat', name: 'blobcat', url: 'https://peer.test/e/blobcat.png', domain: 'peer.test', is_remote: true } },
      { type: 'text', text: 'x' },
    ])
  })
})

describe('noteToContent Emoji tags', () => {
  const note = (id: unknown) => ({
    type: 'Note',
    content: '<p>hi :blobcat:</p>',
    tag: [{ type: 'Emoji', id, name: ':blobcat:', icon: { type: 'Image', url: 'https://peer.test/e/blobcat.png' } }],
  })
  const emojiOf = (parts: any[]) => parts.find((p) => p.type === 'emoji')?.emoji

  it('keeps an IRI tag id and turns a uuid or a missing id into remote:<name>', () => {
    expect(emojiOf(noteToContent(note('https://peer.test/emojis/1'))).id).toBe('https://peer.test/emojis/1')
    expect(emojiOf(noteToContent(note(FOREIGN))).id).toBe('remote:blobcat')
    expect(emojiOf(noteToContent(note(undefined))).id).toBe('remote:blobcat')
  })
})
