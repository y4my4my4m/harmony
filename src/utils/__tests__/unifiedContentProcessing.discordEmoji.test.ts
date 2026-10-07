/**
 * `:discord:<name>:<id>:` in composer text becomes one Discord emoji part;
 * shortcodes, times and URLs around it parse as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The unified pack stays unloaded: no fetch of /assets/emojis.
vi.mock('@/services/unifiedEmojiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/unifiedEmojiService')>()),
  loadEmojiData: vi.fn(async () => {}),
}))

import { supabase } from '@/supabase'
import type { MessagePart } from '@/types'
import {
  convertMessagePartsToText,
  parseContentToMessageParts,
  resolveEmojisData,
} from '@/utils/unifiedContentProcessing'
import { messagePartsToMarkdown, messagePartsToRawText } from '@/utils/messageContentUtils'

const ID = '1376980620600672316'
const ID2 = '1092312766385836082'

const discordPart = (name: string, id: string, ext: 'png' | 'gif') => ({
  type: 'emoji',
  emoji: {
    name,
    url: `https://cdn.discordapp.com/emojis/${id}.${ext}`,
    id: null,
    domain: 'discord.com',
    display_name: name,
    server_id: null,
  },
})

/** Adjacent text parts joined, so assertions do not depend on where unresolved shortcodes split text. */
function merged(parts: MessagePart[]): unknown[] {
  const out: unknown[] = []
  for (const part of parts) {
    const last = out[out.length - 1] as { type?: string; text?: string } | undefined
    if (part.type === 'text' && last?.type === 'text') last.text += part.text
    else out.push(part.type === 'text' ? { type: 'text', text: part.text } : part)
  }
  return out
}

const BLOBCAT = { id: '6f1c2a34-1111-4222-8333-444455556666', name: 'blobcat', url: 'https://harmony.test/storage/v1/object/public/emojis/blobcat.png' }

/** Thenable PostgREST builder resolving to no rows; records `.in()` filters. */
const inCalls: Array<[string, string[]]> = []
function emptyQuery() {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    in: (column: string, values: string[]) => {
      inCalls.push([column, values])
      return builder
    },
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  }
  return builder
}

beforeEach(() => {
  inCalls.length = 0
  vi.mocked(supabase.from).mockImplementation(() => emptyQuery())
})

describe('Discord custom emoji in message text', () => {
  it('parses the production message into one emoji part', async () => {
    const parts = await parseContentToMessageParts(`...factors :discord:heh:${ID}: )`)
    expect(parts).toEqual([
      { type: 'text', text: '...factors ' },
      discordPart('heh', ID, 'png'),
      { type: 'text', text: ' )' },
    ])
  })

  it('parses the animated form to the .gif', async () => {
    const parts = await parseContentToMessageParts(`:discord:a:party_blob:${ID}:`)
    expect(parts).toEqual([discordPart('party_blob', ID, 'gif')])
  })

  it('parses adjacent tokens without a separator', async () => {
    const parts = await parseContentToMessageParts(`:discord:heh:${ID}::discord:a:wave:${ID2}:`)
    expect(parts).toEqual([discordPart('heh', ID, 'png'), discordPart('wave', ID2, 'gif')])
  })

  it.each([
    `:discord:h:${ID}:`,
    `:discord:${'n'.repeat(33)}:${ID}:`,
    `:discord:he-h:${ID}:`,
    `:discord:heh:${'1'.repeat(16)}:`,
    `:discord:heh:${'1'.repeat(21)}:`,
    `:discord:heh:${ID}`,
    `discord:heh:${ID}`,
  ])('keeps %s as text', async (input) => {
    const parts = await parseContentToMessageParts(`x ${input} y`)
    expect(parts.some(p => p.type === 'emoji')).toBe(false)
    expect(merged(parts)).toEqual([{ type: 'text', text: `x ${input} y` }])
  })

  it('leaves shortcodes and times around a token as before', async () => {
    const parts = await parseContentToMessageParts(
      `:blobcat: at 12:30:45 :discord:heh:${ID}: then :nope: and :discord:a:wave:${ID2}:`,
      {},
      { blobcat: BLOBCAT },
    )
    expect(merged(parts)).toEqual([
      { type: 'emoji', emoji: BLOBCAT },
      { type: 'text', text: ' at 12:30:45 ' },
      discordPart('heh', ID, 'png'),
      { type: 'text', text: ' then :nope: and ' },
      discordPart('wave', ID2, 'gif'),
    ])
  })

  it('keeps a token inside a URL or a fenced code block', async () => {
    const url = `https://example.com/a:discord:heh:${ID}:b`
    const inUrl = await parseContentToMessageParts(`see ${url}`)
    expect(inUrl.some(p => p.type === 'emoji')).toBe(false)
    expect(inUrl).toContainEqual({ type: 'url', url, preview: true })

    const fenced = '```\n:discord:heh:' + ID + ':\n```'
    expect(await parseContentToMessageParts(fenced)).toEqual([{ type: 'text', text: fenced }])
  })

  it('looks up no emojis rows for the pieces of a token', async () => {
    await resolveEmojisData(`:discord:heh:${ID}: :discord:a:wave:${ID2}: :blobcat:`)
    expect(inCalls).toEqual([['name', ['blobcat']]])
  })

  it('round-trips through the edit and source text forms', async () => {
    const source = `hi :discord:heh:${ID}: and :discord:a:wave:${ID2}:`
    const parts = await parseContentToMessageParts(source)
    expect(messagePartsToMarkdown(parts)).toBe(source)
    expect(messagePartsToRawText(parts)).toBe(source)
    expect(convertMessagePartsToText(parts)).toBe(source)
    expect(await parseContentToMessageParts(messagePartsToMarkdown(parts))).toEqual(parts)
  })

  it('gives a bridged Discord message the same edit form', () => {
    // Part of runtime/commands.ts in harmony-discord-bridge: no server_id.
    const bridged = [{ type: 'emoji', emoji: { name: 'heh', url: `https://cdn.discordapp.com/emojis/${ID}.png`, id: null, domain: 'discord.com', display_name: 'heh' } }]
    expect(messagePartsToMarkdown(bridged as MessagePart[])).toBe(`:discord:heh:${ID}:`)
  })
})
