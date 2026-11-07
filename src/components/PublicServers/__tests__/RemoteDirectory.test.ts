/**
 * RemoteDirectory.vue, All instances: the merged list (GET /directory/servers) read again from
 * the top while instances are still being read, Load more included, so servers of an instance
 * that answers late appear wherever they sort; a failed read for a new filter shows the error,
 * not the earlier filter's servers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import RemoteDirectory from '../RemoteDirectory.vue'

const { listAdvertisedServers, listDirectoryPeers, browseDirectory } = vi.hoisted(() => ({
  listAdvertisedServers: vi.fn(),
  listDirectoryPeers: vi.fn(),
  browseDirectory: vi.fn(),
}))

vi.mock('@/services/federation', () => ({
  federationServerService: { listAdvertisedServers, listDirectoryPeers, browseDirectory },
  remoteServerUuid: () => null,
}))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ servers: [] }) }))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/InstanceIcon.vue', () => stub('InstanceIcon'))

const server = (name: string, domain = 'a.test') => ({
  id: `https://${domain}/servers/${name}`, name, summary: '', icon: null, memberCount: 1,
  handle: `${name}@${domain}`, category: null, instance: { domain, name: null, icon: null },
})
const servers = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => server(`s${from + i}`))

function page(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    page: { items, total: items.length, nextOffset: null, instances: 1, pending: 0, failed: [], federationOff: false, ...extra },
  }
}

async function render() {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  const wrapper = mount(RemoteDirectory, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const names = (wrapper: Awaited<ReturnType<typeof render>>) =>
  wrapper.findAll('[data-testid="remote-directory-server"] h3').map((h) => h.text())

const loadMore = (wrapper: Awaited<ReturnType<typeof render>>) =>
  wrapper.findAll('button').find((b) => b.text() === 'Load more')!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  listAdvertisedServers.mockReset()
  listDirectoryPeers.mockReset().mockResolvedValue({ peers: [], federationOff: false })
  browseDirectory.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteDirectory, All instances', () => {
  it('reads the rows on screen again after Load more while an instance is pending, so its servers appear above them', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page(servers(0, 30), { total: 40, nextOffset: 30, pending: 1 }))
      .mockResolvedValueOnce(page(servers(30, 40), { total: 40, pending: 1 }))
      .mockResolvedValueOnce(page([server('late', 'late.test'), ...servers(0, 39)], { total: 41, nextOffset: 40, instances: 2 }))
    const wrapper = await render()
    expect(names(wrapper)).toHaveLength(30)

    await loadMore(wrapper).trigger('click')
    await flushPromises()
    expect(names(wrapper)).toHaveLength(40)

    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(listAdvertisedServers).toHaveBeenCalledTimes(3)
    expect(listAdvertisedServers.mock.calls[2]).toEqual(['', 0, 40])
    expect(names(wrapper)[0]).toBe('late')
    expect(names(wrapper)).toHaveLength(40)
    expect(loadMore(wrapper)).toBeTruthy()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(listAdvertisedServers).toHaveBeenCalledTimes(3)
  })

  it('reads from the top when a Load more answer counts another instance', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page(servers(0, 30), { total: 40, nextOffset: 30 }))
      .mockResolvedValueOnce(page(servers(29, 39), { total: 41, nextOffset: 40, instances: 2 }))
      .mockResolvedValueOnce(page([server('late', 'late.test'), ...servers(0, 39)], { total: 41, nextOffset: 40, instances: 2 }))
    const wrapper = await render()

    await loadMore(wrapper).trigger('click')
    await flushPromises()
    expect(listAdvertisedServers.mock.calls[2]).toEqual(['', 0, 40])
    expect(names(wrapper)).toEqual(['late', ...servers(0, 39).map((s) => s.name)])
  })

  it('stops reading again after three answers that still count pending instances', async () => {
    listAdvertisedServers.mockResolvedValue(page(servers(0, 5), { pending: 1 }))
    await render()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(listAdvertisedServers).toHaveBeenCalledTimes(4)
  })

  it('shows the error for a new filter whose read failed, not the servers of the one before', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page([server('alpha'), server('beta')]))
      .mockResolvedValueOnce({ ok: false, unsupported: false })
      .mockResolvedValueOnce(page([server('zulu')]))
    const wrapper = await render()
    expect(names(wrapper)).toEqual(['alpha', 'beta'])

    await wrapper.get('[data-testid="remote-directory-filter"]').setValue('zulu')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(names(wrapper)).toEqual([])
    const error = wrapper.get('[data-testid="remote-directory-advertised-error"]')
    expect(error.text()).toContain("Couldn't read the known instances")
    expect(wrapper.find('[data-testid="remote-directory-filter"]').exists()).toBe(true)
    expect(listAdvertisedServers.mock.calls[1]).toEqual(['zulu', 0, undefined])

    await error.get('button').trigger('click')
    await flushPromises()
    expect(listAdvertisedServers.mock.calls[2]).toEqual(['zulu', 0, undefined])
    expect(names(wrapper)).toEqual(['zulu'])
    expect(wrapper.find('[data-testid="remote-directory-advertised-error"]').exists()).toBe(false)
  })

  it('keeps the list when reading the same filter again fails', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page([server('alpha')], { pending: 1 }))
      .mockResolvedValueOnce({ ok: false, unsupported: false })
    const wrapper = await render()
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(listAdvertisedServers).toHaveBeenCalledTimes(2)
    expect(names(wrapper)).toEqual(['alpha'])
  })
})
