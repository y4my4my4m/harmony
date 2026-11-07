/**
 * The card of an invite link to a server on another Harmony instance: the stored snapshot,
 * refreshed through this instance's backend, drawn as the native invite card with the hosting
 * instance under the button.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import fs from 'node:fs'
import path from 'node:path'
import en from '@/locales/en.json'
import type { EmbedPayload } from '@/types'
import { useRemoteInvitePrompt } from '@/composables/useRemoteInvitePrompt'
import RemoteServerInviteCard from '../RemoteServerInviteCard.vue'

const { remoteInviteCard, openServer, store } = vi.hoisted(() => ({
  remoteInviteCard: vi.fn(),
  openServer: vi.fn(),
  store: { servers: [] as Array<Record<string, unknown>> },
}))

vi.mock('@/services/federation', () => ({
  federationServerService: { remoteInviteCard },
  remoteServerUuid: (id: string) => id.match(/\/servers\/([0-9a-f-]{36})\/?$/i)?.[1].toLowerCase() ?? null,
}))
vi.mock('@/composables/useOpenServer', () => ({ useOpenServer: () => openServer }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => store }))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))

const URL = 'https://peer.example/invite/GOODCODE'
const SERVER_ID = '0b0e0000-0000-4000-8000-0000000000a1'
const GROUP = `https://peer.example/servers/${SERVER_ID}`

function snapshot(server: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    status: 'valid',
    code: 'GOODCODE',
    domain: 'peer.example',
    instance: { name: 'Peer Harmony', icon: 'https://peer.example/icon.png' },
    server: {
      name: 'Timbre', description: 'Alternative Har.mony client', icon: 'https://peer.example/a.png',
      memberCount: 6, onlineCount: 2, id: GROUP, ...server,
    },
    ...extra,
  }
}

function payload(remoteInvite: unknown, url = URL): EmbedPayload {
  return {
    cacheKey: '', url, normalizedUrl: url, provider: 'harmony-remote-invite',
    remoteInvite: remoteInvite as EmbedPayload['remoteInvite'], fetchedAt: '', expiresAt: '',
  }
}

async function render(remoteInvite: unknown, url = URL) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  const wrapper = mount(RemoteServerInviteCard, { props: { payload: payload(remoteInvite, url) }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  remoteInviteCard.mockReset()
  remoteInviteCard.mockResolvedValue(null)
  openServer.mockReset()
  store.servers = reactive([])
  useRemoteInvitePrompt().close()
})

describe('RemoteServerInviteCard', () => {
  it('draws the server as the native card, with the instance under the button', async () => {
    const wrapper = await render(snapshot())
    const card = wrapper.find('[data-testid="remote-invite-card"]')
    expect(card.element.tagName).toBe('ARTICLE')
    expect(card.attributes('aria-label')).toBe('Invite to Timbre')
    expect(wrapper.find('.server-name').text()).toBe('Timbre')
    expect(wrapper.find('.online-count').text()).toBe('2 online')
    expect(wrapper.find('.member-count').text()).toBe('6 members')
    expect(wrapper.find('.server-description').text()).toBe('Alternative Har.mony client')
    const icon = wrapper.find('.server-image')
    expect(icon.attributes()).toMatchObject({ src: 'https://peer.example/a.png', referrerpolicy: 'no-referrer', loading: 'lazy' })
    expect(wrapper.find('.join-button').text()).toBe('Join server')

    const instance = wrapper.find('[data-testid="remote-invite-instance"]')
    expect(instance.find('.remote-invite__instance-name').text()).toBe('Peer Harmony')
    expect(instance.find('.sr-only').text()).toBe('Hosted on Peer Harmony')
    expect(instance.attributes('title')).toBe('Peer Harmony · peer.example')
    expect(instance.find('img').attributes()).toMatchObject({ src: 'https://peer.example/icon.png', alt: '', referrerpolicy: 'no-referrer' })
    // The actions column holds the button, then the instance.
    const actions = wrapper.find('.server-invite-card__actions').element.children
    expect(actions[0].className).toBe('join-button')
    expect(actions[1].getAttribute('data-testid')).toBe('remote-invite-instance')
  })

  it('reads the host from the link and asks this instance for the card', async () => {
    await render(snapshot())
    expect(remoteInviteCard).toHaveBeenCalledWith(URL)
  })

  it('renders text as text', async () => {
    const wrapper = await render(snapshot({ name: '<img src=x onerror=alert(1)>', description: '<b>bold</b>' }))
    expect(wrapper.find('.server-name').text()).toBe('<img src=x onerror=alert(1)>')
    expect(wrapper.find('.server-description').text()).toBe('<b>bold</b>')
    expect(wrapper.find('img[src="x"]').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    for (const file of ['RemoteServerInviteCard.vue', 'InviteCardLayout.vue']) {
      expect(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), file).not.toMatch(/v-html|innerHTML/)
    }
  })

  it('falls back to the monogram, the initial and the Harmony icon', async () => {
    const wrapper = await render(snapshot({ icon: 'http://peer.example/a.png', onlineCount: null }, { instance: { name: 'Peer Harmony', icon: null } }))
    expect(wrapper.find('.server-image').attributes('src')).toMatch(/^data:image\/svg\+xml/)
    expect(wrapper.find('.online-count').exists()).toBe(false)
    await wrapper.find('.server-image').trigger('error')
    expect(wrapper.find('.server-image').exists()).toBe(false)
    expect(wrapper.find('.default-server-icon').text()).toBe('T')
    expect(wrapper.find('[data-testid="remote-invite-instance"] img').attributes('src')).toBe('/img/app_icon_square.webp')
  })

  it('names the host when the instance has no name, and swaps a broken instance icon', async () => {
    const wrapper = await render(snapshot({}, { instance: { name: '' , icon: 'https://peer.example/icon.png' } }))
    expect(wrapper.find('.remote-invite__instance-name').text()).toBe('peer.example')
    expect(wrapper.find('[data-testid="remote-invite-instance"]').attributes('title')).toBe('peer.example')
    await wrapper.find('[data-testid="remote-invite-instance"] img').trigger('error')
    expect(wrapper.find('[data-testid="remote-invite-instance"] img').attributes('src')).toBe('/img/app_icon_square.webp')
  })

  it('draws a dead invite as the invalid state and asks for nothing', async () => {
    const wrapper = await render({ status: 'invalid', instance: { name: 'Peer Harmony', icon: null } })
    expect(wrapper.find('.error-title').text()).toBe('Invalid invite')
    expect(wrapper.find('.error-message').text()).toBe('Invite not found or has expired')
    expect(wrapper.find('.join-button').exists()).toBe(false)
    expect(wrapper.find('[data-testid="remote-invite-card"]').attributes('data-status')).toBe('invalid')
    expect(remoteInviteCard).not.toHaveBeenCalled()
  })

  it('draws a server shut to other instances as closed', async () => {
    const wrapper = await render({ status: 'closed', instance: { name: 'Peer Harmony', icon: null } })
    expect(wrapper.find('.error-title').text()).toBe('Closed to other instances')
    expect(wrapper.find('.error-message').text()).toBe('Only people on Peer Harmony can join this server.')
  })

  it('draws an unreadable snapshot as invalid', async () => {
    const wrapper = await render(snapshot({ name: '' }))
    expect(wrapper.find('.error-title').text()).toBe('Invalid invite')
  })

  it('takes the counts the host answers now', async () => {
    remoteInviteCard.mockResolvedValue(snapshot({ memberCount: 9, onlineCount: 4 }))
    const wrapper = await render(snapshot())
    expect(wrapper.find('.online-count').text()).toBe('4 online')
    expect(wrapper.find('.member-count').text()).toBe('9 members')
  })

  it('turns invalid when the host says the invite died', async () => {
    remoteInviteCard.mockResolvedValue({ status: 'invalid', instance: { name: 'Peer Harmony', icon: null } })
    const wrapper = await render(snapshot())
    expect(wrapper.find('.error-title').text()).toBe('Invalid invite')
  })

  it('opens the cross-instance join dialog for the link', async () => {
    const wrapper = await render(snapshot())
    await wrapper.find('.join-button').trigger('click')
    expect(useRemoteInvitePrompt().pendingUrl.value).toBe(URL)
  })

  it('goes to the copy the viewer already has', async () => {
    store.servers.push({ id: SERVER_ID, is_local_server: false, federation_inbox_url: `${GROUP}/inbox` })
    const wrapper = await render(snapshot())
    expect(wrapper.find('.join-button').exists()).toBe(false)
    await wrapper.find('.joined-button').trigger('click')
    expect(openServer).toHaveBeenCalledWith(SERVER_ID)
    expect(useRemoteInvitePrompt().pendingUrl.value).toBeNull()
  })

  it('does not take a server of this instance with the same id for the copy', async () => {
    store.servers.push({ id: SERVER_ID, is_local_server: true })
    const wrapper = await render(snapshot())
    expect(wrapper.find('.join-button').exists()).toBe(true)
  })
})
