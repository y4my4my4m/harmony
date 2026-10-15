import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SoundboardEmoji from '../SoundboardEmoji.vue'

vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string, size: number) => `${url}?size=${size}` }))

describe('SoundboardEmoji', () => {
  it('shows a custom emoji as an image named :name:, at twice its edge', () => {
    const wrapper = mount(SoundboardEmoji, {
      props: { emoji: '🎉', customEmoji: { name: 'party', url: 'https://cdn.test/party.png' }, size: 14 },
    })
    const img = wrapper.find('img')
    expect(img.attributes()).toMatchObject({ alt: ':party:', src: 'https://cdn.test/party.png?size=28', width: '14', height: '14' })
    expect(wrapper.text()).toBe('')
  })

  it('shows a unicode emoji as text', () => {
    const wrapper = mount(SoundboardEmoji, { props: { emoji: '🎉' } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('🎉')
  })

  it('falls back to a speaker without either, or for a custom emoji without an image', () => {
    expect(mount(SoundboardEmoji).text()).toBe('🔊')
    expect(mount(SoundboardEmoji, { props: { customEmoji: { name: 'gone', url: '' } } }).text()).toBe('🔊')
  })
})
