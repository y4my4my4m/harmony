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

    await wrapper.get('[data-testid="remote-directory-search"]').setValue('zulu')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(names(wrapper)).toEqual([])
    const error = wrapper.get('[data-testid="remote-directory-advertised-error"]')
    expect(error.text()).toContain("Couldn't read the known instances")
    expect(wrapper.find('[data-testid="remote-directory-search"]').exists()).toBe(true)
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

describe('RemoteDirectory, the one search field', () => {
  const field = (wrapper: Awaited<ReturnType<typeof render>>) => wrapper.get('[data-testid="remote-directory-search"]')
  const stats = (wrapper: Awaited<ReturnType<typeof render>>) => wrapper.get('[data-testid="remote-directory-stats"]').text()
  const summary = (wrapper: Awaited<ReturnType<typeof render>>) =>
    wrapper.findAll('[data-testid="discovery-filter-chip"]').map((c) => c.text())

  beforeEach(() => {
    listDirectoryPeers.mockResolvedValue({ peers: [{ domain: 'known.test', software: 'harmony', icon: null }], federationOff: false })
    browseDirectory.mockResolvedValue({
      ok: true,
      page: { domain: 'peer.example', items: [server('harbour', 'peer.example'), server('lighthouse', 'peer.example')], totalItems: 2, next: null },
    })
  })

  it('starts folded, labelled, with the merged list counted', async () => {
    listAdvertisedServers.mockResolvedValue(page([server('alpha'), server('beta')]))
    const wrapper = await render()
    const toggle = wrapper.get('[data-testid="discovery-controls-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('[data-testid="discovery-controls-panel"]').attributes('style')).toContain('display: none')
    expect(wrapper.get(`label[for="${field(wrapper).attributes('id')}"]`).text()).toBe('Search servers or browse an instance')
    expect(stats(wrapper)).toBe('2 servers on 1 instance')
    expect(summary(wrapper)).toEqual([])
  })

  it('filters the merged list as typed and offers no browse for text that is not a domain', async () => {
    listAdvertisedServers.mockResolvedValue(page([server('alpha')]))
    const wrapper = await render()
    await field(wrapper).setValue('music')
    expect(wrapper.find('[data-testid="remote-directory-browse"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(listAdvertisedServers).toHaveBeenLastCalledWith('music', 0, undefined)
    expect(field(wrapper).attributes('enterkeyhint')).toBe('search')
  })

  it('browses a typed domain on Enter: the field empties, the instance becomes the active filter', async () => {
    listAdvertisedServers.mockResolvedValue(page([server('alpha')]))
    const wrapper = await render()
    await field(wrapper).setValue('https://Peer.Example/')
    const offer = wrapper.get('[data-testid="remote-directory-browse"]')
    expect(offer.text()).toContain('Browse peer.example')
    expect(field(wrapper).attributes('enterkeyhint')).toBe('go')

    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(browseDirectory).toHaveBeenCalledWith('peer.example')
    expect((field(wrapper).element as HTMLInputElement).value).toBe('')
    expect(names(wrapper)).toEqual(['harbour', 'lighthouse'])
    expect(stats(wrapper)).toBe('2 servers on peer.example')
    const typed = wrapper.get('[data-testid="remote-directory-typed"]')
    expect(typed.text()).toBe('peer.example')
    expect(typed.attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-testid="remote-directory-all"]').attributes('aria-pressed')).toBe('false')
    expect(summary(wrapper)).toEqual(['Remove filter peer.example'])
  })

  it('filters a browsed instance on this side, and its chip returns to the merged list for the same text', async () => {
    listAdvertisedServers.mockResolvedValue(page([server('alpha')]))
    const wrapper = await render()
    await field(wrapper).setValue('peer.example')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const merged = listAdvertisedServers.mock.calls.length

    await field(wrapper).setValue('light')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(names(wrapper)).toEqual(['lighthouse'])
    expect(stats(wrapper)).toBe('1 server matches')
    expect(listAdvertisedServers.mock.calls.length).toBe(merged)
    expect(summary(wrapper)).toEqual(['Remove filter peer.example', 'Remove filter “light”'])

    await field(wrapper).setValue('nothing here')
    expect(wrapper.get('[data-testid="remote-directory-no-match"]').text()).toContain('No server on peer.example matches “nothing here”.')

    await field(wrapper).setValue('light')
    await wrapper.findAll('[data-testid="discovery-filter-chip"]')[0].trigger('click')
    await flushPromises()
    expect(listAdvertisedServers).toHaveBeenLastCalledWith('light', 0, undefined)
    expect(wrapper.get('[data-testid="remote-directory-all"]').attributes('aria-pressed')).toBe('true')
    expect(summary(wrapper)).toEqual(['Remove filter “light”'])
  })

  it('returns focus to the field when the Browse button leaves with the text', async () => {
    listAdvertisedServers.mockResolvedValue(page([server('alpha')]))
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    const wrapper = mount(RemoteDirectory, { global: { plugins: [i18n] }, attachTo: document.body })
    try {
      await flushPromises()
      await wrapper.get('[data-testid="discovery-controls-toggle"]').trigger('click')
      await field(wrapper).setValue('peer.example')
      const offer = wrapper.get('[data-testid="remote-directory-browse"]')
      ;(offer.element as HTMLButtonElement).focus()
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(wrapper.find('[data-testid="remote-directory-browse"]').exists()).toBe(false)
      expect(document.activeElement).toBe(field(wrapper).element)
    } finally {
      wrapper.unmount()
    }
  })

  it('back on All instances, lists only the earlier rows the text matches until the merged list answers it', async () => {
    let answer: (value: unknown) => void = () => {}
    listAdvertisedServers
      .mockResolvedValueOnce(page([server('alpha'), server('lightship')]))
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const wrapper = await render()
    await field(wrapper).setValue('peer.example')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await field(wrapper).setValue('light')
    await wrapper.get('[data-testid="remote-directory-all"]').trigger('click')
    await flushPromises()
    expect(names(wrapper)).toEqual(['lightship'])
    expect(stats(wrapper)).toBe('')

    answer(page([server('lighthouse'), server('lightship')]))
    await flushPromises()
    expect(names(wrapper)).toEqual(['lighthouse', 'lightship'])
    expect(stats(wrapper)).toBe('2 servers match')
  })

  it('offers to browse a typed domain that no listed server matches', async () => {
    listAdvertisedServers.mockResolvedValueOnce(page([server('alpha')])).mockResolvedValue(page([]))
    const wrapper = await render()
    await field(wrapper).setValue('peer.example')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    const empty = wrapper.get('[data-testid="remote-directory-no-match"]')
    await empty.get('button').trigger('click')
    await flushPromises()
    expect(browseDirectory).toHaveBeenCalledWith('peer.example')
  })

  it('Escape empties a filled field and goes no further; an empty field lets it through', async () => {
    listAdvertisedServers.mockResolvedValue(page([server('alpha')]))
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    const wrapper = mount(RemoteDirectory, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    const reached = vi.fn()
    window.addEventListener('keydown', reached)
    try {
      await field(wrapper).setValue('alp')
      await field(wrapper).trigger('keydown', { key: 'Escape' })
      expect((field(wrapper).element as HTMLInputElement).value).toBe('')
      expect(reached).not.toHaveBeenCalled()
      await field(wrapper).trigger('keydown', { key: 'Escape' })
      expect(reached).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', reached)
      wrapper.unmount()
    }
  })
})

describe('RemoteDirectory, merged list paging and typing', () => {
  const field = (wrapper: Awaited<ReturnType<typeof render>>) => wrapper.get('[data-testid="remote-directory-search"]')
  const stats = (wrapper: Awaited<ReturnType<typeof render>>) => wrapper.get('[data-testid="remote-directory-stats"]').text()

  it('reads more than 60 rows again in pages of 60 while an instance is pending, keeping every row', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page(servers(0, 30), { total: 75, nextOffset: 30, pending: 1 }))
      .mockResolvedValueOnce(page(servers(30, 60), { total: 75, nextOffset: 60, pending: 1 }))
      .mockResolvedValueOnce(page(servers(60, 75), { total: 75, pending: 1 }))
      .mockResolvedValueOnce(page([server('late', 'late.test'), ...servers(0, 59)], { total: 76, nextOffset: 60, instances: 2 }))
      .mockResolvedValueOnce(page(servers(59, 74), { total: 76, nextOffset: 75, instances: 2 }))
    const wrapper = await render()
    await loadMore(wrapper).trigger('click')
    await flushPromises()
    await loadMore(wrapper).trigger('click')
    await flushPromises()
    expect(names(wrapper)).toHaveLength(75)

    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(listAdvertisedServers.mock.calls.slice(3)).toEqual([['', 0, 60], ['', 60, 15]])
    expect(names(wrapper)).toHaveLength(75)
    expect(names(wrapper)[0]).toBe('late')
    expect(names(wrapper).at(-1)).toBe('s73')
    expect(loadMore(wrapper)).toBeTruthy()
  })

  it('starts a paged read over once when a later page counts other instances', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page(servers(0, 30), { total: 75, nextOffset: 30, pending: 1 }))
      .mockResolvedValueOnce(page(servers(30, 60), { total: 75, nextOffset: 60, pending: 1 }))
      .mockResolvedValueOnce(page(servers(60, 75), { total: 75, pending: 1 }))
      .mockResolvedValueOnce(page(servers(0, 60), { total: 75, nextOffset: 60, pending: 1 }))
      .mockResolvedValueOnce(page(servers(59, 74), { total: 76, nextOffset: 74, instances: 2 }))
      .mockResolvedValueOnce(page([server('late', 'late.test'), ...servers(0, 59)], { total: 76, nextOffset: 60, instances: 2 }))
      .mockResolvedValueOnce(page(servers(59, 74), { total: 76, nextOffset: 75, instances: 2 }))
    const wrapper = await render()
    await loadMore(wrapper).trigger('click')
    await flushPromises()
    await loadMore(wrapper).trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(listAdvertisedServers.mock.calls.slice(3)).toEqual([['', 0, 60], ['', 60, 15], ['', 0, 60], ['', 60, 15]])
    expect(names(wrapper)[0]).toBe('late')
    expect(names(wrapper)).toHaveLength(75)
  })

  it('says a failed Load more failed and keeps the button to try again', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page(servers(0, 30), { total: 40, nextOffset: 30 }))
      .mockResolvedValueOnce({ ok: false, unsupported: false })
      .mockResolvedValueOnce(page(servers(30, 40), { total: 40 }))
    const wrapper = await render()
    await loadMore(wrapper).trigger('click')
    await flushPromises()
    const failed = wrapper.get('[data-testid="remote-directory-more-failed"]')
    expect(failed.text()).toBe("Couldn't load more servers. Try again.")
    expect(failed.attributes('role')).toBe('alert')
    expect(names(wrapper)).toHaveLength(30)

    await loadMore(wrapper).trigger('click')
    await flushPromises()
    expect(names(wrapper)).toHaveLength(40)
    expect(wrapper.find('[data-testid="remote-directory-more-failed"]').exists()).toBe(false)
  })

  it('says a failed Load more of a browsed instance failed, keeping its servers', async () => {
    listAdvertisedServers.mockResolvedValue(page([server('alpha')]))
    browseDirectory
      .mockResolvedValueOnce({ ok: true, page: { domain: 'peer.example', items: servers(0, 20), totalItems: 25, next: 'https://peer.example/servers/directory?page=2' } })
      .mockResolvedValueOnce({ ok: false, refusal: 'unreachable' })
    const wrapper = await render()
    await field(wrapper).setValue('peer.example')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await loadMore(wrapper).trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="remote-directory-more-failed"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-directory-error"]').exists()).toBe(false)
    expect(names(wrapper)).toHaveLength(20)
  })

  it('moves focus from Load more to the first row it added when the last page arrives', async () => {
    listAdvertisedServers
      .mockResolvedValueOnce(page(servers(0, 30), { total: 40, nextOffset: 30 }))
      .mockResolvedValueOnce(page(servers(30, 40), { total: 40 }))
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    const wrapper = mount(RemoteDirectory, { global: { plugins: [i18n] }, attachTo: document.body })
    try {
      await flushPromises()
      const button = loadMore(wrapper)
      ;(button.element as HTMLButtonElement).focus()
      await button.trigger('click')
      await flushPromises()
      expect(wrapper.findAll('button').some((b) => b.text() === 'Load more')).toBe(false)
      const rows = wrapper.findAll('[data-testid="remote-directory-server"]')
      expect(document.activeElement).toBe(rows[30].element)
    } finally {
      wrapper.unmount()
    }
  })

  it('narrows the rows at once as text is typed, and counts only once the merged list answers', async () => {
    let answer: (value: unknown) => void = () => {}
    listAdvertisedServers
      .mockResolvedValueOnce(page([server('alpha'), server('alpine'), server('beta')]))
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const wrapper = await render()
    expect(stats(wrapper)).toBe('3 servers on 1 instance')

    await field(wrapper).setValue('ALP')
    expect(names(wrapper)).toEqual(['alpha', 'alpine'])
    expect(stats(wrapper)).toBe('')
    expect(wrapper.find('[data-testid="remote-directory-no-match"]').exists()).toBe(false)

    await field(wrapper).setValue('zzz')
    expect(names(wrapper)).toEqual([])
    expect(wrapper.find('[data-testid="remote-directory-no-match"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Reading the directories of known instances')

    await field(wrapper).setValue('alp')
    await vi.advanceTimersByTimeAsync(300)
    answer(page([server('alpha'), server('alpine'), server('alpaca', 'b.test')]))
    await flushPromises()
    expect(names(wrapper)).toEqual(['alpha', 'alpine', 'alpaca'])
    expect(stats(wrapper)).toBe('3 servers match')
  })
})
