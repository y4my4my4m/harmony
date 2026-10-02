/**
 * PublicServersContent.vue: a new list or page renders a first batch of cards
 * in its first frame and the rest of the page two animation frames later.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import PublicServersContent from '../PublicServersContent.vue'

vi.mock('@/components/common/ServerCard.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'ServerCard',
      props: { server: { type: Object, required: true }, isJoined: Boolean, isLoading: Boolean },
      setup: (props) => () => h('article', { class: 'card', 'data-id': (props.server as { id: string }).id }),
    }),
  }
})
vi.mock('@/components/common/ServerCardSkeleton.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'ServerCardSkeleton', render: () => h('div') }) }
})
vi.mock('@/components/common/EmptyState.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'EmptyState', render: () => h('div') }) }
})

let frames: Array<FrameRequestCallback | null> = []

function runFrame() {
  const due = frames
  frames = []
  for (const cb of due) cb?.(0)
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { if (id > 0) frames[id - 1] = null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const servers = (n: number, prefix = 's') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}` }) as any)

function mountContent(props: { servers: any[]; featuredServers?: any[] }) {
  return mount(PublicServersContent, {
    props: {
      servers: props.servers,
      featuredServers: props.featuredServers ?? [],
      isLoading: false,
      isEmpty: false,
      isEmptyResults: false,
      searchQuery: '',
      joinedServerIds: new Set<string>(),
      loadingServerIds: new Set<string>(),
      error: null,
    },
    global: { mocks: { $t: (key: string) => key } },
  })
}

const listedIds = (wrapper: ReturnType<typeof mountContent>) =>
  wrapper.findAll('.servers-section:last-of-type .card').map(c => c.attributes('data-id'))

async function settle() {
  runFrame()
  runFrame()
  await nextTick()
}

describe('PublicServersContent staged rendering', () => {
  it('renders nine cards first and the full page two frames later', async () => {
    const wrapper = mountContent({ servers: servers(30) })
    expect(wrapper.findAll('.card')).toHaveLength(9)

    runFrame()
    await nextTick()
    expect(wrapper.findAll('.card')).toHaveLength(9)

    runFrame()
    await nextTick()
    expect(wrapper.findAll('.card')).toHaveLength(20)
    expect(wrapper.find('.load-more-section').exists()).toBe(true)
  })

  it('counts featured cards against the first batch', async () => {
    const featured = servers(6, 'f')
    const wrapper = mountContent({ servers: [...featured, ...servers(30)], featuredServers: featured })
    expect(wrapper.findAll('.card')).toHaveLength(9)
    expect(listedIds(wrapper)).toEqual(['s0', 's1', 's2'])

    await settle()
    expect(wrapper.findAll('.card')).toHaveLength(26)
  })

  it('restarts the stages and the paging when the list changes', async () => {
    const wrapper = mountContent({ servers: servers(30) })
    await settle()
    await wrapper.find('.load-more-section button').trigger('click')
    await settle()
    expect(wrapper.findAll('.card')).toHaveLength(30)

    await wrapper.setProps({ servers: servers(25, 'g') })
    expect(wrapper.findAll('.card')).toHaveLength(9)
    expect(listedIds(wrapper)[0]).toBe('g0')

    await settle()
    expect(wrapper.findAll('.card')).toHaveLength(20)
  })

  it('adds a first batch of the next page, then the rest of it', async () => {
    const wrapper = mountContent({ servers: servers(50) })
    await settle()

    await wrapper.find('.load-more-section button').trigger('click')
    expect(wrapper.findAll('.card')).toHaveLength(29)

    await settle()
    expect(wrapper.findAll('.card')).toHaveLength(40)
  })

  it('drops the pending stage on unmount', () => {
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const wrapper = mountContent({ servers: servers(30) })
    wrapper.unmount()
    expect(cancel).toHaveBeenCalled()
  })
})
