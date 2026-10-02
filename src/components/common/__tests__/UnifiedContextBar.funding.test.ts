/**
 * The context bar's funding entry: the goal pill when a goal is shown, else a support button
 * on desktop while funding is enabled.
 */

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UnifiedContextBar from '../UnifiedContextBar.vue'

type Config = {
  enabled: boolean
  show_in_context_bar: boolean
  goal_amount: number | null
  current_amount: number
  goal_currency: string
  goal_description: string | null
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    show_in_context_bar: true,
    goal_amount: 100,
    current_amount: 40,
    goal_currency: 'USD',
    goal_description: null,
    ...overrides,
  }
}

function render(fundingConfig: Config | null, isMobile = false) {
  return mount(UnifiedContextBar, {
    props: { mode: 'chat', isMobile, fundingConfig: fundingConfig as never },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { Icon: true, ServerIcon: true },
    },
  })
}

describe('UnifiedContextBar funding entry', () => {
  it('shows the goal pill when a goal is shown', () => {
    const w = render(config())
    expect(w.find('.funding-progress-track').exists()).toBe(true)
    expect(w.find('[data-testid="funding-support"]').exists()).toBe(false)
  })

  it('shows a support button on desktop when funding is enabled without a shown goal', () => {
    for (const cfg of [config({ show_in_context_bar: false }), config({ goal_amount: null })]) {
      const w = render(cfg)
      expect(w.find('.funding-progress-track').exists()).toBe(false)
      expect(w.find('[data-testid="funding-support"]').text()).toBe('activitypub.supportInstance')
    }
  })

  it('the support button opens funding', async () => {
    const w = render(config({ show_in_context_bar: false }))
    await w.find('[data-testid="funding-support"]').trigger('click')
    expect(w.emitted('open-funding')).toHaveLength(1)
  })

  it('shows nothing on phones without a goal, or when funding is disabled', () => {
    expect(render(config({ show_in_context_bar: false }), true).find('.funding-indicator').exists()).toBe(false)
    expect(render(config({ enabled: false })).find('.funding-indicator').exists()).toBe(false)
    expect(render(null).find('.funding-indicator').exists()).toBe(false)
  })
})
