/**
 * Favourites and boosts list of a post: two tabs opened on the one clicked,
 * accounts linking to their profiles, pages of 40 behind "Show more", and one
 * closing line for the count the rows here do not cover.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import type { InteractionAccount, InteractionAccountsPage, ListedInteraction } from '@/services/postInteractionAccounts'

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/postInteractionAccounts', () => ({ fetchInteractionAccounts: fetchMock }))

import PostInteractionsDialog from '../PostInteractionsDialog.vue'

const account = (name: string, domain?: string): InteractionAccount => {
  const routeHandle = domain ? `${name}@${domain}` : name
  return {
    interactionId: `i-${routeHandle}`,
    id: `p-${routeHandle}`,
    username: name,
    displayName: `${name[0].toUpperCase()}${name.slice(1)}`,
    avatarUrl: `/a/${name}.png`,
    handle: `@${routeHandle}`,
    routeHandle,
  }
}

const page = (accounts: InteractionAccount[], nextOffset: number, hasMore = false): InteractionAccountsPage =>
  ({ accounts, nextOffset, hasMore })

type Pages = Partial<Record<ListedInteraction, Record<number, InteractionAccountsPage>>>

const serve = (pages: Pages) => {
  fetchMock.mockImplementation(async (_postId: string, type: ListedInteraction, offset = 0) => {
    const found = pages[type]?.[offset]
    if (!found) throw new Error(`no page ${type}@${offset}`)
    return found
  })
}

const mountDialog = (props: Partial<{ initialTab: ListedInteraction; favoritesCount: number; boostsCount: number }> = {}) =>
  mount(PostInteractionsDialog, {
    attachTo: document.body,
    props: {
      postId: 'post-1',
      initialTab: props.initialTab ?? 'favorite',
      favoritesCount: props.favoritesCount ?? 2,
      boostsCount: props.boostsCount ?? 1,
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        BaseModal: { emits: ['close'], template: '<div class="base-modal-stub"><slot /></div>' },
        RouterLink: RouterLinkStub,
        Avatar: { props: ['src'], template: '<img class="avatar-stub" :src="src" />' },
        DisplayName: { props: ['userId', 'fallback'], template: '<span class="display-name-stub" :data-user-id="userId">{{ fallback }}</span>' },
        LoadingSpinner: true,
        Icon: true,
      },
    },
  })

type Wrapper = ReturnType<typeof mountDialog>

const tab = (wrapper: Wrapper, type: ListedInteraction) => wrapper.get(`[data-testid="post-interactions-tab-${type}"]`)
const rows = (wrapper: Wrapper) => wrapper.findAll('[data-testid="post-interactions-account"]')
const elsewhere = (wrapper: Wrapper) => wrapper.find('[data-testid="post-interactions-elsewhere"]')

beforeEach(() => {
  fetchMock.mockReset()
  document.body.innerHTML = ''
})

describe('PostInteractionsDialog', () => {
  it('opens on the tab clicked and lists its accounts with names, handles and profile links', async () => {
    serve({ reblog: { 0: page([account('carol'), account('dan', 'remote.example')], 2) } })
    const wrapper = mountDialog({ initialTab: 'reblog', boostsCount: 2 })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('post-1', 'reblog', 0)
    expect(tab(wrapper, 'reblog').attributes('aria-selected')).toBe('true')
    expect(tab(wrapper, 'favorite').attributes('aria-selected')).toBe('false')
    expect(tab(wrapper, 'reblog').attributes('tabindex')).toBe('0')
    expect(tab(wrapper, 'favorite').attributes('tabindex')).toBe('-1')

    const panel = wrapper.get('[role="tabpanel"]')
    expect(panel.attributes('aria-labelledby')).toBe(tab(wrapper, 'reblog').attributes('id'))
    expect(tab(wrapper, 'reblog').attributes('aria-controls')).toBe(panel.attributes('id'))

    const links = wrapper.findAllComponents(RouterLinkStub)
    expect(links.map((l) => l.props('to'))).toEqual([
      { name: 'UserProfile', params: { handle: 'carol' } },
      { name: 'UserProfile', params: { handle: 'dan@remote.example' } },
    ])
    expect(rows(wrapper)[0].text()).toContain('Carol')
    expect(rows(wrapper)[0].text()).toContain('@carol')
    expect(rows(wrapper)[1].text()).toContain('@dan@remote.example')
    expect(rows(wrapper)[1].get('.display-name-stub').attributes('data-user-id')).toBe('p-dan@remote.example')
    expect(elsewhere(wrapper).exists()).toBe(false)
  })

  it('shows each tab with its count and loads the other tab once, on first selection', async () => {
    serve({
      favorite: { 0: page([account('alice'), account('bob')], 2) },
      reblog: { 0: page([account('carol')], 1) },
    })
    const wrapper = mountDialog({ favoritesCount: 2, boostsCount: 1 })
    await flushPromises()

    expect(tab(wrapper, 'favorite').text()).toMatch(/Favorites\s*2/)
    expect(tab(wrapper, 'reblog').text()).toMatch(/Boosts\s*1/)
    expect(rows(wrapper)).toHaveLength(2)

    await tab(wrapper, 'reblog').trigger('click')
    await flushPromises()
    expect(rows(wrapper).map((r) => r.text())).toEqual([expect.stringContaining('Carol')])

    await tab(wrapper, 'favorite').trigger('click')
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('moves selection and focus with the arrow keys, Home and End', async () => {
    serve({ favorite: { 0: page([], 0) }, reblog: { 0: page([], 0) } })
    const wrapper = mountDialog({ favoritesCount: 0, boostsCount: 0 })
    await flushPromises()

    await tab(wrapper, 'favorite').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(tab(wrapper, 'reblog').attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab(wrapper, 'reblog').element)

    await tab(wrapper, 'reblog').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(tab(wrapper, 'favorite').attributes('aria-selected')).toBe('true')

    await tab(wrapper, 'favorite').trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(tab(wrapper, 'reblog').attributes('aria-selected')).toBe('true')

    await tab(wrapper, 'reblog').trigger('keydown', { key: 'Home' })
    await flushPromises()
    expect(document.activeElement).toBe(tab(wrapper, 'favorite').element)
  })

  it('pages with "Show more" and moves focus to the first account added', async () => {
    const first = Array.from({ length: 40 }, (_, i) => account(`user${i}`))
    serve({ favorite: { 0: page(first, 40, true), 40: page([account('late'), account('later', 'remote.example')], 42) } })
    const wrapper = mountDialog({ favoritesCount: 42 })
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(40)
    const more = wrapper.get('[data-testid="post-interactions-more"]')
    expect(more.text()).toBe('Show more')
    expect(elsewhere(wrapper).exists()).toBe(false)

    await more.trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenLastCalledWith('post-1', 'favorite', 40)
    expect(rows(wrapper)).toHaveLength(42)
    expect(document.activeElement).toBe(rows(wrapper)[40].element)
    expect(wrapper.find('[data-testid="post-interactions-more"]').exists()).toBe(false)
    expect(elsewhere(wrapper).exists()).toBe(false)
  })

  it('ends the list with the count the rows here do not cover', async () => {
    serve({ favorite: { 0: page([account('alice'), account('bob')], 2) } })
    const wrapper = mountDialog({ favoritesCount: 5 })
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(2)
    expect(elsewhere(wrapper).text()).toBe("3 more on other servers aren't listed here.")
    expect(tab(wrapper, 'favorite').text()).toMatch(/Favorites\s*5/)
  })

  it('says it in the singular for one', async () => {
    serve({ favorite: { 0: page([account('alice')], 1) } })
    const wrapper = mountDialog({ favoritesCount: 2 })
    await flushPromises()
    expect(elsewhere(wrapper).text()).toBe("1 more on another server isn't listed here.")
  })

  it('names the accounts elsewhere in place of the empty state when none are stored here', async () => {
    serve({ reblog: { 0: page([], 0) } })
    const wrapper = mountDialog({ initialTab: 'reblog', boostsCount: 12 })
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.find('[data-testid="post-interactions-empty"]').exists()).toBe(false)
    expect(elsewhere(wrapper).text()).toBe("12 accounts on other servers aren't listed here.")
  })

  it('shows the empty state for a tab with no accounts', async () => {
    serve({ reblog: { 0: page([], 0) } })
    const wrapper = mountDialog({ initialTab: 'reblog', boostsCount: 0 })
    await flushPromises()
    expect(wrapper.get('[data-testid="post-interactions-empty"]').text()).toContain('No one has boosted this post yet.')
    expect(elsewhere(wrapper).exists()).toBe(false)
  })

  it('shows the loading state until the first page arrives', async () => {
    let resolve!: (value: InteractionAccountsPage) => void
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.text()).toContain('Loading...')

    resolve(page([account('alice'), account('bob')], 2))
    await flushPromises()
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-busy')).toBe('false')
    expect(rows(wrapper)).toHaveLength(2)
  })

  it('offers a retry when the list fails to load', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.text()).toContain("Couldn't load this list.")

    serve({ favorite: { 0: page([account('alice'), account('bob')], 2) } })
    await wrapper.get('.list-empty__button').trigger('click')
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(2)
  })

  it('closes on a plain click of an account and stays open for a modified click', async () => {
    serve({ favorite: { 0: page([account('alice'), account('bob')], 2) } })
    const wrapper = mountDialog()
    await flushPromises()

    await rows(wrapper)[0].trigger('click', { button: 0, ctrlKey: true })
    expect(wrapper.emitted('close')).toBeUndefined()

    await rows(wrapper)[0].trigger('click', { button: 0 })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes from its close button', async () => {
    serve({ favorite: { 0: page([], 0) } })
    const wrapper = mountDialog({ favoritesCount: 0 })
    await wrapper.get('button[aria-label="Close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
