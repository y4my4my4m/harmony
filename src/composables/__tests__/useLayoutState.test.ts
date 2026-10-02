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

describe('mobile drawer widths', () => {
  it('leave DRAWER_PEEK_PX of chat beside an open drawer on phones', async () => {
    const mod = await load()
    for (const vw of [375, 390, 412]) {
      expect(vw - 72 - mod.mobileChannelPanelWidth(vw)).toBe(mod.DRAWER_PEEK_PX)
      expect(vw - mod.mobileMemberPanelWidth(vw)).toBe(mod.DRAWER_PEEK_PX)
    }
  })

  it('never go below the fixed widths or above their caps', async () => {
    const mod = await load()
    expect(mod.mobileChannelPanelWidth(320)).toBe(240)
    expect(mod.mobileMemberPanelWidth(320)).toBe(280)
    expect(mod.mobileChannelPanelWidth(480)).toBe(300)
    expect(mod.mobileMemberPanelWidth(480)).toBe(380)
  })

  it('keep the fixed widths on tablets', async () => {
    const mod = await load()
    expect(mod.mobileChannelPanelWidth(768)).toBe(240)
    expect(mod.mobileMemberPanelWidth(768)).toBe(280)
  })
})

describe('useLayoutState drag spans with registered panel widths (mobile)', () => {
  beforeEach(() => {
    route.path = '/chat'
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
  })

  // ChatLayout's registration: channel panel left, member list right.
  function chatHost(mod: Awaited<ReturnType<typeof load>>) {
    let state!: ReturnType<typeof mod.useLayoutState>
    mount(defineComponent({
      setup() {
        state = mod.useLayoutState()
        mod.useSidebarPanel('left', () => true, () => state.channelPanelWidth.value)
        mod.useSidebarPanel('right', () => true, () => state.memberPanelWidth.value)
        return () => h('div')
      },
    }))
    return state
  }

  it('spans the rail plus the channel panel on the left and the member list on the right', async () => {
    const mod = await load()
    const state = chatHost(mod)
    expect(state.channelPanelWidth.value).toBe(262)
    expect(state.memberPanelWidth.value).toBe(334)
    expect(state.leftDrawerWidth.value).toBe(72 + 262)
    expect(state.rightDrawerWidth.value).toBe(334)
  })

  it('moves the rail with the finger over the whole left span', async () => {
    const mod = await load()
    const state = chatHost(mod)
    state.startDrag('left')
    state.updateDragOffset(167, 'left')
    expect(state.serverSidebarDragStyle.value).toMatchObject({ transform: 'translateX(-167px)' })
    state.updateDragOffset(500, 'left')
    expect(state.leftSidebarDragOffset.value).toBe(334)
    state.endDragWithVelocity(0, 'left')
    expect(state.leftSidebarOpen.value).toBe(true)
  })

  it('closes the member list on a drag past 60% of its width', async () => {
    const mod = await load()
    const state = chatHost(mod)
    state.openRightSidebar()
    state.startDrag('right')
    expect(state.rightSidebarDragOffset.value).toBe(334)
    state.updateDragOffset(210, 'right')
    expect(state.rightSidebarDragOffset.value).toBe(124)
    state.endDragWithVelocity(0, 'right')
    expect(state.rightSidebarOpen.value).toBe(false)
  })
})
