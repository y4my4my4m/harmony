import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { mount } from '@vue/test-utils'

const route = reactive({ path: '/today' })
vi.mock('vue-router', () => ({ useRoute: () => route }))

async function load() {
  vi.resetModules()
  return import('../useLayoutState')
}

// Mounts a component holding the layout state, optionally declaring panels the
// way ChatLayout and SocialLayout do.
function host(mod: Awaited<ReturnType<typeof load>>, panels: Array<'left' | 'right'> = []) {
  let state!: ReturnType<typeof mod.useLayoutState>
  const Host = defineComponent({
    setup() {
      state = mod.useLayoutState()
      for (const side of panels) mod.useSidebarPanel(side)
      return () => h('div')
    },
  })
  const wrapper = mount(Host)
  return { state, wrapper }
}

describe('useLayoutState side panels (mobile)', () => {
  beforeEach(() => {
    route.path = '/today'
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true })
  })

  it('has no right sidebar and a rail-only left drawer without registered panels', async () => {
    const mod = await load()
    const { state } = host(mod)
    expect(state.isMobile.value).toBe(true)
    expect(state.hasRightSidebar.value).toBe(false)
    expect(state.leftDrawerWidth.value).toBe(state.SERVER_SIDEBAR_WIDTH)
  })

  it('ignores a right-edge drag and flick where no right panel exists', async () => {
    const mod = await load()
    const { state } = host(mod)
    state.startDrag('right')
    state.updateDragOffset(-200, 'right')
    state.endDragWithVelocity(-1.2, 'right')
    expect(state.isDragging.value).toBe(false)
    expect(state.rightSidebarOpen.value).toBe(false)

    state.toggleRightSidebar()
    state.openRightSidebar()
    expect(state.rightSidebarOpen.value).toBe(false)
  })

  it('tracks a left drag over the rail width when no left panel exists', async () => {
    const mod = await load()
    const { state } = host(mod)
    state.startDrag('left')
    state.updateDragOffset(150, 'left')
    expect(state.leftSidebarDragOffset.value).toBe(state.SERVER_SIDEBAR_WIDTH)
    expect(state.serverSidebarDragStyle.value).toMatchObject({ transform: 'translateX(0px)' })

    state.endDragWithVelocity(0, 'left')
    expect(state.leftSidebarOpen.value).toBe(true)
  })

  it('opens the right drawer only while a layout declares it', async () => {
    const mod = await load()
    const { state } = host(mod)
    const layout = host(mod, ['left', 'right'])
    expect(state.hasRightSidebar.value).toBe(true)
    expect(state.leftDrawerWidth.value).toBe(state.SIDEBAR_WIDTH)

    state.openRightSidebar()
    expect(state.rightSidebarOpen.value).toBe(true)

    layout.wrapper.unmount()
    await Promise.resolve()
    expect(state.hasRightSidebar.value).toBe(false)
    expect(state.rightSidebarOpen.value).toBe(false)
  })
})
