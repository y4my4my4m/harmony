import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import BridgeSourceBadge from '../BridgeSourceBadge.vue'

const theme = vi.hoisted(() => ({ mode: 'icon' }))
vi.mock('@/composables/useVisualTheme', () => ({ useVisualTheme: () => ({ settings: { value: { bridgeSourceBadge: theme.mode } } }) }))

describe('bridge source indicator', () => {
  it.each(['icon', 'text'])('shows accessible Matrix and Discord %s indicators', mode => {
    theme.mode = mode
    for (const source of ['matrix', 'discord']) {
      const wrapper = mount(BridgeSourceBadge, { props: { source }, global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
      const label = `Bridged from ${source === 'matrix' ? 'Matrix' : 'Discord'}`
      expect(wrapper.get('[aria-label]').attributes('aria-label')).toBe(label)
      if (mode === 'icon') expect(wrapper.find('svg').exists()).toBe(true)
      else expect(wrapper.text()).toBe(source.toUpperCase())
      wrapper.unmount()
    }
  })
})
