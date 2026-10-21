/**
 * PostsContainer.vue as a WAI-ARIA feed: a labelled role="feed" whose articles carry
 * aria-posinset/aria-setsize, PageDown/PageUp and j/k between articles (j/k not while
 * typing), Ctrl+End to the Load more button outside the feed, and a load started from
 * that button announcing its count and focusing the first new post.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const { polite } = vi.hoisted(() => ({ polite: vi.fn() }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite, assertive: vi.fn(), announce: vi.fn() }) }))

const MonyPostStub = vi.hoisted(() => ({
  name: 'MonyPost',
  props: { post: Object, posinset: Number, setsize: Number },
  render(this: { post: { id: string }; posinset: number; setsize: number }) {
    return h('article', { tabindex: '-1', 'aria-posinset': this.posinset, 'aria-setsize': this.setsize, 'data-id': this.post.id }, [
      h('button', { class: 'fav' }, 'Favorite'),
      h('input', { class: 'reply-field' }),
    ])
  },
}))
vi.mock('@/components/activitypub/MonyPost.vue', () => ({ default: defineComponent(MonyPostStub as any) }))
vi.mock('@/components/common/EmptyState.vue', () => ({ default: defineComponent({ name: 'EmptyState', render: () => null }) }))
vi.mock('@/components/common/LoadingSpinner.vue', () => ({ default: defineComponent({ name: 'LoadingSpinner', render: () => null }) }))

import PostsContainer from '../PostsContainer.vue'

enableAutoUnmount(afterEach)

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const posts = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `p${from + i + 1}` }))

const article = (n: number) => document.querySelector<HTMLElement>(`article[aria-posinset="${n}"]`)

function key(k: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
}

async function settle() {
  await flushPromises()
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  await nextTick()
}

// happy-dom lays nothing out; the virtualizer reads offsetHeight for the viewport
// and each row, px.
const VIEWPORT = 800
const ROW = 100
const sized = (el: HTMLElement) => (el.classList.contains('posts-container') ? VIEWPORT : ROW)
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

beforeEach(() => {
  document.body.innerHTML = ''
  polite.mockClear()
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return sized(this) } })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 600 })
})

afterEach(() => {
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
})

describe('PostsContainer feed', () => {
  it('renders a labelled feed whose articles carry their position and the set size', async () => {
    const wrapper = mount(PostsContainer, { props: { posts: posts(3), hasMore: true, feedLabel: 'Local timeline' }, attachTo: document.body })
    await settle()
    const feed = wrapper.get('[role="feed"]')
    expect(feed.attributes('aria-label')).toBe('Local timeline')
    expect(feed.attributes('aria-busy')).toBe('false')
    expect(article(1)?.getAttribute('aria-setsize')).toBe('-1')
    expect(article(3)?.dataset.id).toBe('p3')

    await wrapper.setProps({ hasMore: false })
    expect(article(1)?.getAttribute('aria-setsize')).toBe('3')
    // A feed owns articles only; Load more sits after it.
    expect(feed.find('[data-testid="feed-load-more"]').exists()).toBe(false)
  })

  it('moves between articles with PageDown/PageUp and j/k, but not while typing', async () => {
    mount(PostsContainer, { props: { posts: posts(4), hasMore: false }, attachTo: document.body })
    await settle()
    article(1)!.focus()
    key('PageDown')
    await settle()
    expect(document.activeElement).toBe(article(2))
    key('j')
    await settle()
    expect(document.activeElement).toBe(article(3))
    key('k')
    await settle()
    expect(document.activeElement).toBe(article(2))
    key('PageUp')
    await settle()
    expect(document.activeElement).toBe(article(1))

    article(1)!.querySelector<HTMLElement>('.fav')!.focus()
    key('j')
    await settle()
    expect(document.activeElement).toBe(article(2))

    const field = article(2)!.querySelector<HTMLInputElement>('.reply-field')!
    field.focus()
    key('j')
    key('PageDown')
    await settle()
    expect(document.activeElement).toBe(field)
  })

  it('keeps the focused article rendered while its row is scrolled out of the window', async () => {
    const wrapper = mount(PostsContainer, { props: { posts: posts(40), hasMore: false }, attachTo: document.body })
    await settle()
    article(1)!.focus()
    const scroller = wrapper.get('.posts-container').element as HTMLElement
    scroller.scrollTop = 30 * ROW
    scroller.dispatchEvent(new Event('scroll'))
    await settle()
    expect(article(35)).not.toBeNull()
    expect(article(2)).toBeNull()
    expect(article(1)).not.toBeNull()
    expect(document.activeElement).toBe(article(1))
  })

  it('Ctrl+End reaches Load more; a load it starts is announced and focuses the first new post', async () => {
    const wrapper = mount(PostsContainer, { props: { posts: posts(3), hasMore: true }, attachTo: document.body })
    await settle()
    article(1)!.focus()
    key('End', { ctrlKey: true })
    const loadMore = document.querySelector<HTMLElement>('[data-testid="feed-load-more"]')!
    expect(document.activeElement).toBe(loadMore)

    // The last row is in view, so a load has started already; the click joins it
    // rather than sending a second request.
    expect(wrapper.emitted('load-more')).toHaveLength(1)
    loadMore.click()
    expect(wrapper.emitted('load-more')).toHaveLength(1)
    await wrapper.setProps({ isLoading: true })
    expect(loadMore.getAttribute('aria-disabled')).toBe('true')

    await wrapper.setProps({ posts: [...posts(3), ...posts(2, 3)], isLoading: false, hasMore: false })
    await settle()
    expect(polite).toHaveBeenCalledWith('activitypub.feedA11y.postsLoaded:{"count":2}', { key: 'feed-loaded' })
    expect(document.activeElement).toBe(article(4))
    expect(document.querySelector('[data-testid="feed-load-more"]')).toBeNull()
  })
})

describe('PostsContainer reading position', () => {
  // Boxes from the rows' absolute offsets and the scroller's scrollTop; the scroller's top is 0.
  // A scrollTop write fires scroll, as a browser does; happy-dom does not.
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element & { _top?: number }) { return this._top ?? 0 },
      set(this: Element & { _top?: number }, value: number) {
        this._top = Math.max(0, value)
        this.dispatchEvent(new Event('scroll'))
      },
    })
    Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const scroller = document.querySelector<HTMLElement>('.posts-container')
      const top = this.classList.contains('virtual-post-row')
        ? parseFloat(this.style.top) - (scroller?.scrollTop ?? 0)
        : 0
      const height = sized(this)
      return { top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    }
  })
  afterEach(() => {
    if (rect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect)
    if (scrollTop) Object.defineProperty(Element.prototype, 'scrollTop', scrollTop)
  })

  async function scrollTo(scroller: HTMLElement, top: number) {
    scroller.scrollTop = top
    await settle()
  }

  it('reads the first post on screen and how far it is scrolled past', async () => {
    const wrapper = mount(PostsContainer, { props: { posts: posts(40), hasMore: false }, attachTo: document.body })
    await settle()
    const scroller = wrapper.get('.posts-container').element as HTMLElement
    await scrollTo(scroller, 10 * ROW + 37)

    expect((wrapper.vm as any).readScrollAnchor()).toEqual({ postId: 'p11', offset: 37, scrollTop: 10 * ROW + 37 })
  })

  it('scrolls back to the anchored post and offset', async () => {
    const wrapper = mount(PostsContainer, { props: { posts: posts(40), hasMore: false }, attachTo: document.body })
    await settle()
    const scroller = wrapper.get('.posts-container').element as HTMLElement

    await (wrapper.vm as any).restoreScrollAnchor({ postId: 'p21', offset: 12, scrollTop: 0 })

    expect(scroller.scrollTop).toBe(20 * ROW + 12)
  })

  it('follows the anchored post when posts were added above it', async () => {
    const wrapper = mount(PostsContainer, { props: { posts: posts(40), hasMore: false }, attachTo: document.body })
    await settle()
    const scroller = wrapper.get('.posts-container').element as HTMLElement
    await scrollTo(scroller, 10 * ROW + 37)
    const anchor = (wrapper.vm as any).readScrollAnchor()

    await wrapper.setProps({ posts: [...posts(3, 100), ...posts(40)] })
    await scrollTo(scroller, 0)
    await (wrapper.vm as any).restoreScrollAnchor(anchor)

    expect(scroller.scrollTop).toBe(13 * ROW + 37)
  })

  it('falls back to the saved scrollTop once the post is gone, and to the top without an anchor', async () => {
    const wrapper = mount(PostsContainer, { props: { posts: posts(40), hasMore: false }, attachTo: document.body })
    await settle()
    const scroller = wrapper.get('.posts-container').element as HTMLElement

    await (wrapper.vm as any).restoreScrollAnchor({ postId: 'gone', offset: 12, scrollTop: 1234 })
    expect(scroller.scrollTop).toBe(1234)

    await (wrapper.vm as any).restoreScrollAnchor(null)
    expect(scroller.scrollTop).toBe(0)
  })
})
