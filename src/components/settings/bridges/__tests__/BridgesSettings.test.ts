/** BridgesSettings.vue and bridgesSection.ts: Server settings → Bridges, tabs Discord | Matrix. */
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import BridgesSettings from '../BridgesSettings.vue'
import { requestedSettingsSection } from '../bridgesSection'

const DiscordStub = { name: 'DiscordBridgeSetup', props: ['serverId', 'serverName', 'linkReturn', 'headingLevel'], template: '<div class="discord-stub" />' }
const MatrixStub = { name: 'MatrixBridgeSetup', props: ['serverId'], template: '<div class="matrix-stub" />' }

let wrapper: VueWrapper
afterEach(() => wrapper?.unmount())

function mountBridges(props: Record<string, unknown> = {}) {
  wrapper = mount(BridgesSettings, {
    props: { serverId: 's1', serverName: 'Club', ...props },
    attachTo: document.body,
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { DiscordBridgeSetup: DiscordStub, MatrixBridgeSetup: MatrixStub },
    },
  })
  return wrapper
}

const tab = (id: string) => wrapper.get(`[data-testid="bridges-tab-${id}"]`)
const panel = (id: string) => wrapper.get(`[data-testid="bridges-panel-${id}"]`)
const shown = (id: string) => (panel(id).element as HTMLElement).style.display !== 'none'

describe('BridgesSettings', () => {
  it('heads the section and opens the Discord tab with only the Discord panel mounted', () => {
    mountBridges()
    expect(wrapper.get('h2').text()).toBe('Bridges')
    const list = wrapper.get('[role="tablist"]')
    expect(list.attributes('aria-labelledby')).toBe(wrapper.get('h2').attributes('id'))
    expect(wrapper.findAll('[role="tab"]').map(t => t.text())).toEqual(['Discord', 'Matrix'])
    expect(tab('discord').attributes()).toMatchObject({ 'aria-selected': 'true', tabindex: '0' })
    expect(tab('matrix').attributes()).toMatchObject({ 'aria-selected': 'false', tabindex: '-1' })
    expect(panel('discord').attributes('aria-labelledby')).toBe(tab('discord').attributes('id'))
    expect(tab('discord').attributes('aria-controls')).toBe(panel('discord').attributes('id'))
    expect(shown('discord')).toBe(true)
    expect(shown('matrix')).toBe(false)
    expect(wrapper.findComponent(DiscordStub).props()).toMatchObject({ serverId: 's1', serverName: 'Club', linkReturn: null, headingLevel: 3 })
    expect(wrapper.findComponent(MatrixStub).exists()).toBe(false)
  })

  it('passes the OAuth2 link return to the Discord panel', () => {
    mountBridges({ linkReturn: { linked: true, error: null } })
    expect(wrapper.getComponent(DiscordStub).props('linkReturn')).toEqual({ linked: true, error: null })
  })

  it('mounts a panel on its first visit and keeps the other mounted but hidden', async () => {
    mountBridges()
    await tab('matrix').trigger('click')
    expect(wrapper.emitted('update:tab')?.[0]).toEqual(['matrix'])
    await wrapper.setProps({ tab: 'matrix' })
    expect(shown('matrix')).toBe(true)
    expect(shown('discord')).toBe(false)
    expect(wrapper.getComponent(MatrixStub).props('serverId')).toBe('s1')
    expect(wrapper.findComponent(DiscordStub).exists()).toBe(true)
    expect(tab('matrix').attributes('tabindex')).toBe('0')
    expect(tab('discord').attributes('tabindex')).toBe('-1')
  })

  it('opens the tab it is given, mounting nothing else', () => {
    mountBridges({ tab: 'matrix' })
    expect(shown('matrix')).toBe(true)
    expect(wrapper.findComponent(MatrixStub).exists()).toBe(true)
    expect(wrapper.findComponent(DiscordStub).exists()).toBe(false)
  })

  it('moves focus and selection with the arrow keys, Home and End', async () => {
    mountBridges()
    ;(tab('discord').element as HTMLElement).focus()
    await tab('discord').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('matrix').element)
    expect(wrapper.emitted('update:tab')?.at(-1)).toEqual(['matrix'])
    await wrapper.setProps({ tab: 'matrix' })
    await tab('matrix').trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(tab('discord').element)
    expect(wrapper.emitted('update:tab')?.at(-1)).toEqual(['discord'])
    await wrapper.setProps({ tab: 'discord' })
    await tab('discord').trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(tab('matrix').element)
  })
})

describe('requestedSettingsSection', () => {
  it.each([
    [{ section: 'discord-bridge' }, 'bridges', 'discord'],
    [{ section: 'matrix-bridge' }, 'bridges', 'matrix'],
    [{ section: 'bridges' }, 'bridges', 'discord'],
    [{ section: 'bridges', tab: 'matrix' }, 'bridges', 'matrix'],
    [{ section: 'bridges', tab: 'discord' }, 'bridges', 'discord'],
    [{ section: 'bridges', tab: 'irc' }, 'bridges', 'discord'],
    [{ section: 'discord-bridge', linked: '1' }, 'bridges', 'discord'],
    [{ section: 'bridges', tab: 'matrix', link_error: 'discord_denied' }, 'bridges', 'discord'],
    [{ section: 'matrix-bridge', linked: '1' }, 'bridges', 'discord'],
    [{ section: 'roles', tab: 'matrix' }, 'roles', 'discord'],
    [{}, null, 'discord'],
  ])('reads %j as section %s, tab %s', (query, section, bridgeTab) => {
    expect(requestedSettingsSection(query)).toEqual({ section, bridgeTab })
  })
})
