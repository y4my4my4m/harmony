import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

// A bridged Discord reaction names its emoji discord:[a:]name:id and carries no url; the row
// shows the emoji image from Discord's CDN, not the token.

vi.mock('@/components/DisplayName.vue', () => ({ default: { template: '<span class="actor" />' } }))
vi.mock('@/components/common/Avatar.vue', () => ({ default: { template: '<span />' } }))
vi.mock('@/components/common/Icon.vue', () => ({ default: { template: '<i />' } }))

const NotificationItem = (await import('../NotificationItem.vue')).default
const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false })

function row(emojiName: string) {
  return mount(NotificationItem, {
    global: { plugins: [i18n] },
    props: {
      now: new Date(),
      notification: {
        id: 'n1', type: 'reaction', is_read: false, created_at: new Date().toISOString(),
        data: { sender: { display_name: 'win-bee' }, reaction: { emoji_name: emojiName } },
      } as any,
    },
  })
}

describe('NotificationItem reaction emoji', () => {
  it('renders a bridged Discord emoji from the CDN', () => {
    const img = row('discord:Vibing_Cat:896231014437896192').find('img.inline-emoji')
    expect(img.attributes('src')).toBe('https://cdn.discordapp.com/emojis/896231014437896192.png')
    expect(img.attributes('alt')).toBe('Vibing_Cat')
  })

  it('renders an animated one as gif and leaves unicode as text', () => {
    expect(row('discord:a:party:123456789012345678').find('img.inline-emoji').attributes('src'))
      .toBe('https://cdn.discordapp.com/emojis/123456789012345678.gif')
    const unicode = row('🔥')
    expect(unicode.find('img.inline-emoji').exists()).toBe(false)
    expect(unicode.find('.inline-emoji-text').text()).toBe('🔥')
  })
})
