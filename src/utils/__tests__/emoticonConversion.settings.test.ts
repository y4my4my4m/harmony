/**
 * Emoticon conversion at send (parse options from the user setting) and at
 * render (chatMessageTextRenderer), plus `:alias:` resolution at send.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/services/emojiIndexedDBCache', () => ({
  getCachedStaticEmojiData: vi.fn(async () => null),
  setCachedStaticEmojiData: vi.fn(async () => {}),
  getAllCachedServerEmojis: vi.fn(async () => []),
  setCachedServerEmojis: vi.fn(async () => {}),
  removeCachedServerEmojis: vi.fn(async () => {}),
  getCachedServerEmojis: vi.fn(async () => null),
}))
vi.mock('@/services/userDataService', () => ({ userDataService: { reResolveAllDisplayNames: () => {} } }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 'srv-1', channels: [] }),
}))

import { loadEmojiData } from '@/services/unifiedEmojiService'
import { parseContentToMessageParts, resolveEmojisData } from '@/utils/unifiedContentProcessing'
import { buildChatParseOptions } from '@/utils/chatParseOptions'
import { emoticonPreferences, useVisualTheme } from '@/composables/useVisualTheme'
import { renderChatMessageText, type ChatMessageRendererOptions } from '@/utils/chatMessageTextRenderer'
import type { MessagePart } from '@/types'

let realFetch: typeof fetch

beforeAll(async () => {
  setActivePinia(createPinia())
  const json = readFileSync(resolve(__dirname, '../../../public/assets/emojis/unicode-emoji-data.json'), 'utf8')
  realFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (url: string) =>
    String(url).includes('unicode-emoji-data.json') ? new Response(json) : new Response('{}'),
  ) as unknown as typeof fetch
  await loadEmojiData()
})

afterAll(() => {
  globalThis.fetch = realFetch
})

afterEach(() => {
  useVisualTheme().updateSettings({ convertSentEmoticons: true, renderEmoticonsAsEmoji: true })
})

const textOf = (parts: MessagePart[]) => parts.map(p => (p.type === 'text' ? p.text : p.type === 'url' ? p.url : `[${p.type}]`)).join('')

async function send(input: string, isDM = false) {
  const emojiDataMap = await resolveEmojisData(input)
  return textOf(await parseContentToMessageParts(input, {}, emojiDataMap, {}, {}, buildChatParseOptions(isDM)))
}

describe('emoticon settings', () => {
  it('both default on', () => {
    expect(emoticonPreferences()).toEqual({ convertSent: true, renderReceived: true })
  })

  it('chat parse options follow "Convert emoticons I send"', () => {
    expect(buildChatParseOptions(false).convertEmoticons).toBe(true)
    expect(buildChatParseOptions(true).convertEmoticons).toBe(true)
    useVisualTheme().updateSettings({ convertSentEmoticons: false })
    expect(buildChatParseOptions(false).convertEmoticons).toBe(false)
    expect(buildChatParseOptions(true).convertEmoticons).toBe(false)
  })
})

describe('send-time conversion', () => {
  it('converts emoticons and leaves code, URLs and times alone', async () => {
    expect(await send('hi :) at 12:30 `:)` https://example.com/:D <3')).toBe(
      'hi 🙂 at 12:30 `:)` https://example.com/:D ❤️',
    )
  })

  it('leaves fenced code untouched', async () => {
    expect(await send('```\n:)\n```\nok :D')).toBe('```\n:)\n```\nok 😃')
  })

  it('sends emoticons verbatim with the setting off', async () => {
    useVisualTheme().updateSettings({ convertSentEmoticons: false })
    expect(await send('hi :) <3', true)).toBe('hi :) <3')
  })

  it('resolves Discord and GitHub aliases in :name: form', async () => {
    expect(await send(':joy: :thumbsup: :+1: :slight_smile: :flag_us: :heart:')).toBe('😂 👍 👍 🙂 🇺🇸 ❤️')
  })

  it('leaves an unknown shortcode as text', async () => {
    expect(await send(':definitely_not_an_emoji:')).toBe(':definitely_not_an_emoji:')
  })
})

describe('render-time conversion', () => {
  const base: ChatMessageRendererOptions = {
    isNativePack: true,
    emojiServiceLoaded: true,
    resolveEmoji: () => ({ display: { type: 'native', content: '' } }),
    isSingleEmoji: false,
    greentextEnabled: true,
  }

  it('renders emoticons as emoji when on', () => {
    const { renderedText } = renderChatMessageText('nice :D <3 `:)`', { ...base, convertEmoticons: true })
    expect(renderedText).toContain('nice 😃 ❤️')
    expect(renderedText).toContain('<code class="md-code">:)</code>')
  })

  it('keeps emoticons as typed when off', () => {
    const { renderedText } = renderChatMessageText('nice :D <3', { ...base, convertEmoticons: false })
    expect(renderedText).toBe('nice :D &lt;3')
  })

  it('does not touch fenced code', () => {
    const { codeBlocks } = renderChatMessageText('```\n:)\n```', { ...base, convertEmoticons: true })
    expect(codeBlocks[0].code).toBe(':)')
  })

  it('leaves greentext `>:(` alone', () => {
    const { renderedText } = renderChatMessageText('>:(', { ...base, convertEmoticons: true })
    expect(renderedText).toContain(':(')
  })
})
