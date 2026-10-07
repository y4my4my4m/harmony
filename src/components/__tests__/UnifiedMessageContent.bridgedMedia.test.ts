/**
 * File parts a Discord bridge relays: voice messages and audio files render the audio player,
 * PNG/APNG/GIF stickers from Discord's CDN render as images.
 */
import { describe, it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key } }),
}))

import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'

const VOICE = {
  type: 'file',
  fileType: 'audio',
  url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg',
  fileName: 'voice-message.ogg',
}
const STICKER = { type: 'file', fileType: 'image', url: 'https://media.discordapp.net/stickers/749054660769218631.png?size=160' }

function render(content: unknown[]) {
  setActivePinia(createPinia())
  return shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', isEditing: false, editableContent: '' },
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('bridged media parts', () => {
  it('plays a relayed voice message in the audio player', () => {
    const w = render([VOICE])
    const audio = w.find('audio')
    expect(audio.exists()).toBe(true)
    expect(audio.attributes('src')).toBe(VOICE.url)
    expect(w.find('video').exists()).toBe(false)
  })

  it('keeps the audio player beside an image', () => {
    const w = render([VOICE, STICKER])
    expect(w.find('audio').attributes('src')).toBe(VOICE.url)
    expect(w.find('img.content-image').attributes('src')).toBe(STICKER.url)
  })

  it('shows a Discord sticker as an image at its CDN url', () => {
    const w = render([STICKER])
    expect(w.find('img.content-image').attributes('src')).toBe(STICKER.url)
  })
})
