/**
 * The 404 page: one heading, the address that matched nothing, Sign in as the way forward when
 * signed out and the app home when signed in, Go back only when there is an in-app page to return
 * to, decorative art with its box reserved before the image loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'

enableAutoUnmount(afterEach)

const { auth, route, router, art } = vi.hoisted(() => ({
  auth: { isLoggedIn: false },
  route: { path: '/404-public', redirectedFrom: undefined as undefined | { path: string; fullPath: string } },
  router: { back: vi.fn(), options: { history: { state: { back: null as string | null } } } },
  art: { url: '/backgrounds/404/1.webp' },
}))

vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => router }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/utils/backgroundUtils', () => ({ randomNotFoundImage: () => art.url }))

const RouterLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.())
  },
})

const { default: NotFoundView } = await import('../NotFoundView.vue')
const { default: NotFound404 } = await import('@/components/error/NotFound404.vue')

function open(attrs: Record<string, unknown> = {}) {
  return mount(NotFoundView, { attrs, global: { stubs: { RouterLink, Icon: true } } })
}

beforeEach(() => {
  auth.isLoggedIn = false
  route.path = '/404-public'
  route.redirectedFrom = undefined
  router.back.mockReset()
  router.options.history.state.back = null
  art.url = '/backgrounds/404/1.webp'
})

describe('NotFoundView', () => {
  it('signed out: one heading, Sign in as the primary action, no Go back on a fresh load', () => {
    const wrapper = open()
    const headings = wrapper.findAll('h1')
    expect(headings).toHaveLength(1)
    expect(headings[0].text()).toBe('notFound.pageNotFound')
    expect(wrapper.text()).toContain('notFound.defaultNotFound')

    const primary = wrapper.get('[data-testid="not-found-primary"]')
    expect(primary.attributes('href')).toBe('/login')
    expect(primary.text()).toBe('auth.signIn')
    expect(wrapper.find('[data-testid="not-found-back"]').exists()).toBe(false)
  })

  it('signed in: the primary action goes to the app home', () => {
    auth.isLoggedIn = true
    route.path = '/404'
    const primary = open().get('[data-testid="not-found-primary"]')
    expect(primary.attributes('href')).toBe('/chat')
    expect(primary.text()).toBe('notFound.goHome')
  })

  it('words the page after the address that matched nothing', () => {
    auth.isLoggedIn = true
    route.path = '/404'
    route.redirectedFrom = { path: '/social/nowhere', fullPath: '/social/nowhere' }
    const wrapper = open()
    expect(wrapper.text()).toContain('notFound.socialNotFound')
    const primary = wrapper.get('[data-testid="not-found-primary"]')
    expect(primary.attributes('href')).toBe('/social/home')
    expect(primary.text()).toBe('notFound.backToSocial')
  })

  it('shows the requested path, decoded, without query or hash', () => {
    route.redirectedFrom = { path: '/caf%C3%A9/menu', fullPath: '/caf%C3%A9/menu?token=secret#access_token=x' }
    const path = open().get('[data-testid="not-found-path"]')
    expect(path.get('code').text()).toBe('/café/menu')
    expect(path.text()).not.toContain('secret')
    expect(path.text()).not.toContain('access_token')
    expect(path.get('.sr-only').text()).toBe('notFound.requestedAddress')
  })

  it('hides the path when nothing redirected here', () => {
    expect(open().find('[data-testid="not-found-path"]').exists()).toBe(false)
  })

  it('offers Go back when an in-app page precedes this one', async () => {
    router.options.history.state.back = '/chat/server/channel'
    const wrapper = open()
    await wrapper.get('[data-testid="not-found-back"]').trigger('click')
    expect(router.back).toHaveBeenCalledOnce()
  })

  it('art is decorative and its box is reserved before the image loads', () => {
    const wrapper = open()
    const box = wrapper.get('[data-testid="not-found-art"]')
    expect(box.attributes('aria-hidden')).toBe('true')
    const img = box.get('img')
    expect(img.attributes('alt')).toBe('')
    expect(img.attributes('src')).toBe('/backgrounds/404/1.webp')
    expect(img.attributes('width')).toBe('720')
    expect(img.attributes('height')).toBe('720')
    expect(img.classes()).not.toContain('is-loaded')
  })

  it('fades the art in on load and keeps its box when the image fails', async () => {
    const wrapper = open()
    const img = wrapper.get('[data-testid="not-found-img"]')
    await img.trigger('load')
    expect(img.classes()).toContain('is-loaded')
    await img.trigger('error')
    expect(wrapper.find('[data-testid="not-found-art"]').exists()).toBe(true)
    expect((img.element as HTMLImageElement).style.display).toBe('none')
  })

  it('renders no art box when the 404 folder is empty', () => {
    art.url = ''
    expect(open().find('[data-testid="not-found-art"]').exists()).toBe(false)
  })

  it('keeps RouterView props off the DOM', () => {
    const root = open({ 'is-mobile': true, 'left-sidebar-open': false }).get('[data-testid="not-found"]')
    expect(root.attributes('is-mobile')).toBeUndefined()
    expect(root.attributes('left-sidebar-open')).toBeUndefined()
  })
})

describe('NotFound404 overrides', () => {
  it('takes title, description and the home action from props', () => {
    auth.isLoggedIn = true
    const wrapper = mount(NotFound404, {
      props: {
        title: 'Server Not Found',
        description: 'No such server.',
        homeButtonText: 'Browse Servers',
        suggestedRoute: '/browse-servers',
      },
      global: { stubs: { RouterLink, Icon: true } },
    })
    expect(wrapper.get('h1').text()).toBe('Server Not Found')
    expect(wrapper.text()).toContain('No such server.')
    const primary = wrapper.get('[data-testid="not-found-primary"]')
    expect(primary.attributes('href')).toBe('/browse-servers')
    expect(primary.text()).toBe('Browse Servers')
  })
})
