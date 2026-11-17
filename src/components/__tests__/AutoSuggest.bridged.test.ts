/**
 * The mention picker shows a Discord and a Matrix person alike: name, username line and
 * platform badge, and an option name that says where the person is bridged from.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

const theme = vi.hoisted(() => ({ mode: 'icon' }))
vi.mock('@/composables/useVisualTheme', () => ({ useVisualTheme: () => ({ settings: { value: { bridgeSourceBadge: theme.mode } } }) }))

import AutoSuggest from '../AutoSuggest.vue'

const person = (platform: 'discord' | 'matrix') => ({
  id: `${platform}:x`, display_name: 'Sam', username: 'sam', display_text: '@sam', isBridged: true, bridgeSource: platform,
  avatar: '', user: { id: 'x' },
})

describe.each(['icon', 'text'])('bridged suggestions (badge %s)', mode => {
  it('render Discord and Matrix the same way', () => {
    theme.mode = mode
    const wrapper = mount(AutoSuggest, {
      props: { isVisible: true, suggestions: [person('discord'), person('matrix')] },
      global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })], stubs: { Teleport: true, Avatar: true } },
    })
    const options = wrapper.findAll('[role="option"]')
    expect(options).toHaveLength(2)
    for (const [index, platform] of (['discord', 'matrix'] as const).entries()) {
      const option = options[index]
      expect(option.get('.suggest-name').text()).toBe('Sam')
      expect(option.get('.suggest-username').text()).toBe('sam')
      expect(option.getComponent({ name: 'BridgeSourceBadge' }).props('source')).toBe(platform)
      expect(option.attributes('aria-label')).toContain(`Bridged from ${platform === 'discord' ? 'Discord' : 'Matrix'}`)
      if (mode === 'text') expect(option.get('.bridge-source-badge').text()).toBe(platform.toUpperCase())
      else expect(option.find('.bridged-source-icon svg path').exists()).toBe(true)
    }
    expect(wrapper.text()).not.toContain('example.org')
    wrapper.unmount()
  })
})
