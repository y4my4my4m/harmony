import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KeyboardNavigationHelp from '../KeyboardNavigationHelp.vue'

describe('KeyboardNavigationHelp', () => {
  it('lists the message list keys after the navigation keys', () => {
    const wrapper = mount(KeyboardNavigationHelp)
    const rows = wrapper.findAll('[data-testid="kbd-help-messages"] .kbd-nav-help__row')
    expect(rows.map((row) => row.get('kbd').text())).toEqual([
      'move', 'menu', 'edit', 'reply', 'react', 'pin', 'delete', 'copy', 'thread',
    ].map((key) => `a11y.shortcuts.messages.${key}Keys`))
    expect(wrapper.get('h4').text()).toBe('a11y.shortcuts.messages.title')
  })
})
