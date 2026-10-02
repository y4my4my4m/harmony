/**
 * The welcome screen, the onboarding suggestion cards and the composer prompt: what they
 * render and what they emit.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ServerWelcomeScreen from '../ServerWelcomeScreen.vue'
import OnboardingServerSuggestions from '../OnboardingServerSuggestions.vue'
import RulesAcceptPrompt from '../RulesAcceptPrompt.vue'

const global = {
  stubs: { Icon: true, ServerIcon: true },
  mocks: {
    $t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  },
}

const RULES = [
  { title: 'Be kind', description: 'No personal attacks.' },
  { title: 'No spam', description: '' },
]

describe('ServerWelcomeScreen', () => {
  it('shows the server, the rendered message and the numbered rules', () => {
    const w = mount(ServerWelcomeScreen, {
      props: { server: { name: 'Town Hall' }, message: 'Hello **there**', rules: RULES },
      global,
    })
    expect(w.find('.ws-title').text()).toBe('Town Hall')
    expect(w.find('.ws-message').html()).toContain('<strong class="md-bold">there</strong>')
    const items = w.findAll('.ws-rule')
    expect(items).toHaveLength(2)
    expect(items[0].find('.ws-rule-title').text()).toBe('Be kind')
    expect(items[0].find('.ws-rule-description').text()).toBe('No personal attacks.')
    expect(items[1].find('.ws-rule-description').exists()).toBe(false)
  })

  it('offers Got it, which closes', async () => {
    const w = mount(ServerWelcomeScreen, {
      props: { server: { name: 'S' }, message: 'Hi', rules: RULES, action: 'ok' },
      global,
    })
    const button = w.get('[data-testid="welcome-screen-action"]')
    expect(button.text()).toBe('serverWelcome.gotIt')
    await button.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('accept')).toBeUndefined()
  })

  it('offers Accept rules when acceptance is pending', async () => {
    const w = mount(ServerWelcomeScreen, {
      props: { server: { name: 'S' }, message: '', rules: RULES, action: 'accept' },
      global,
    })
    expect(w.find('.ws-note').text()).toBe('serverWelcome.acceptNote')
    await w.get('[data-testid="welcome-screen-action"]').trigger('click')
    expect(w.emitted('accept')).toHaveLength(1)
  })

  it('disables the button while accepting and shows an error', () => {
    const w = mount(ServerWelcomeScreen, {
      props: { server: { name: 'S' }, message: '', rules: RULES, action: 'accept', busy: true, error: 'Nope' },
      global,
    })
    expect(w.get('[data-testid="welcome-screen-action"]').attributes('disabled')).toBeDefined()
    expect(w.get('[role="alert"]').text()).toBe('Nope')
  })

  it('says so when there is nothing to show', () => {
    const w = mount(ServerWelcomeScreen, { props: { server: { name: 'S' }, message: '  ', rules: [] }, global })
    expect(w.find('.ws-empty').exists()).toBe(true)
    expect(w.find('.ws-rules').exists()).toBe(false)
  })
})

describe('OnboardingServerSuggestions', () => {
  const hall = { id: 'hall', name: 'Town Hall', description: 'Say hi', icon: null, banner: null, member_count: 83 }

  it('presents the welcome server with its member count and joins it', async () => {
    const w = mount(OnboardingServerSuggestions, {
      props: { servers: [hall], source: 'welcome', instanceName: 'Harmony' },
      global,
    })
    expect(w.find('.os-heading').text()).toBe('welcomeServer.recommendedHeading')
    expect(w.find('.os-name').text()).toBe('Town Hall')
    expect(w.find('.os-description').text()).toBe('Say hi')
    expect(w.find('.os-members').text()).toContain('"count":"83"')
    await w.get('[data-testid="onboarding-join"]').trigger('click')
    expect(w.emitted('join')).toEqual([['hall']])
  })

  it('names the instance for featured servers and can be skipped', async () => {
    const w = mount(OnboardingServerSuggestions, {
      props: { servers: [hall, { ...hall, id: 'b', name: 'B' }], source: 'featured', instanceName: 'Harmony', skipLabel: 'Later' },
      global,
    })
    expect(w.find('.os-heading').text()).toContain('"instance":"Harmony"')
    expect(w.findAll('.os-card')).toHaveLength(2)
    const skip = w.get('[data-testid="onboarding-skip"]')
    expect(skip.text()).toBe('Later')
    await skip.trigger('click')
    expect(w.emitted('skip')).toHaveLength(1)
  })

  it('locks every button while a join is in flight', () => {
    const w = mount(OnboardingServerSuggestions, {
      props: { servers: [hall], source: 'welcome', instanceName: 'Harmony', joiningId: 'hall' },
      global,
    })
    expect(w.get('[data-testid="onboarding-join"]').text()).toBe('welcomeServer.joining')
    expect(w.get('[data-testid="onboarding-join"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-testid="onboarding-skip"]').attributes('disabled')).toBeDefined()
  })
})

describe('RulesAcceptPrompt', () => {
  it('names the server and asks to review the rules', async () => {
    const w = mount(RulesAcceptPrompt, { props: { serverName: 'Town Hall' }, global })
    expect(w.text()).toContain('"server":"Town Hall"')
    await w.get('[data-testid="rules-accept-open"]').trigger('click')
    expect(w.emitted('review')).toHaveLength(1)
  })
})
