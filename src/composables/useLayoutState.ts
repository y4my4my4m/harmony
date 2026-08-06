import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { debug } from '@/utils/debug'

const STORAGE_KEY_ACTIVITYPUB_RIGHT_SIDEBAR = 'harmony_activitypub_right_sidebar_open'
// Chat (member list) right sidebar persists independently of the ActivityPub
// right sidebar; collapsing one context leaves the other untouched, and passing
// through a DM (no right sidebar) does not strand the member list collapsed.
const STORAGE_KEY_CHAT_RIGHT_SIDEBAR = 'harmony_chat_right_sidebar_open'

// Global layout state
const leftSidebarOpen = ref(false)
const rightSidebarOpen = ref(false)
const voicePanelOpen = ref(false)
const profileOpen = ref(false)
const mobileProfileOpen = ref(false)
const isMobile = ref(false)

// Mobile drag gesture state
const isDragging = ref(false)
const dragDirection = ref<'left' | 'right' | null>(null)
const leftSidebarDragOffset = ref(0)
const rightSidebarDragOffset = ref(0)

const leftSidebarWasOpen = ref(false)
const rightSidebarWasOpen = ref(false)

// Sidebar configuration
const SIDEBAR_WIDTH = 280
const SERVER_SIDEBAR_WIDTH = 72

// Mobile breakpoint: 768px.
// Sidebar state is mutated only on desktop<->mobile transitions and first mount.
// The mobile soft keyboard fires `resize` on every keystroke; closing sidebars
// on each call would dismiss the sidebar around the DM search input mid-typing.
let hasInitialized = false
const checkMobileDevice = () => {
  const wasMobile = isMobile.value
  const nowMobile = typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  isMobile.value = nowMobile

  const isInitialMount = !hasInitialized
  const becameMobile = !wasMobile && nowMobile
  const becameDesktop = wasMobile && !nowMobile
  hasInitialized = true

  if (isInitialMount || becameMobile) {
    if (nowMobile) {
      leftSidebarOpen.value = false
      rightSidebarOpen.value = false
      profileOpen.value = false
      mobileProfileOpen.value = false
    } else {
      leftSidebarOpen.value = true
      rightSidebarOpen.value = true
    }
    return
  }

  if (becameDesktop) {
    if (!leftSidebarOpen.value) leftSidebarOpen.value = true
    rightSidebarOpen.value = true
  }
  // Same-mode resize (e.g. mobile keyboard show/hide): leave sidebars alone.
}

const handleResize = () => {
  checkMobileDevice()
}

export function useLayoutState() {
  const route = useRoute()

  const isActivityPubRoute = (): boolean => {
    const p = route.path
    return p.startsWith('/social') || p.startsWith('/posts')
  }

  // DM routes have no right sidebar. Suppresses the right-sidebar
  // toggle/gesture/overlay so the mobile backdrop blur never covers a screen
  // with nothing to reveal.
  const isDMRoute = (): boolean => route.path.startsWith('/dm')
  const isChatRoute = (): boolean => route.path.startsWith('/chat')
  const hasRightSidebar = computed(() => !isDMRoute())

  const restoreActivityPubRightSidebar = () => {
    if (typeof window === 'undefined' || isMobile.value) return
    const saved = localStorage.getItem(STORAGE_KEY_ACTIVITYPUB_RIGHT_SIDEBAR)
    if (saved !== null) {
      rightSidebarOpen.value = saved === 'true'
    }
  }

  const persistActivityPubRightSidebar = () => {
    if (typeof window === 'undefined' || !isActivityPubRoute()) return
    localStorage.setItem(STORAGE_KEY_ACTIVITYPUB_RIGHT_SIDEBAR, String(rightSidebarOpen.value))
  }

  const restoreChatRightSidebar = () => {
    if (typeof window === 'undefined' || isMobile.value) return
    const saved = localStorage.getItem(STORAGE_KEY_CHAT_RIGHT_SIDEBAR)
    // First run defaults to open (member list visible), matching desktop.
    rightSidebarOpen.value = saved === null ? true : saved === 'true'
  }

  const persistChatRightSidebar = () => {
    if (typeof window === 'undefined' || !isChatRoute()) return
    localStorage.setItem(STORAGE_KEY_CHAT_RIGHT_SIDEBAR, String(rightSidebarOpen.value))
  }

  onMounted(() => {
    if (typeof window !== 'undefined') {
      checkMobileDevice()
      if (!isMobile.value) {
        if (isActivityPubRoute()) restoreActivityPubRightSidebar()
        else if (isChatRoute()) restoreChatRightSidebar()
      }
      window.addEventListener('resize', handleResize)
    }
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', handleResize)
    }
  })

  watch(
    () => route.path,
    (path) => {
      // DM has no right sidebar; collapse it so the mobile backdrop blur does
      // not linger over a panel-less screen. Chat member-list state stays in
      // localStorage and is restored on return to /chat.
      if (path.startsWith('/dm')) {
        rightSidebarOpen.value = false
        return
      }
      if (isMobile.value) return
      if (path.startsWith('/social') || path.startsWith('/posts')) {
        restoreActivityPubRightSidebar()
      } else if (path.startsWith('/chat')) {
        restoreChatRightSidebar()
      }
    },
    { immediate: true }
  )

  // Each persist helper guards on its own route, so only the active context
  // is written.
  watch(rightSidebarOpen, () => {
    persistActivityPubRightSidebar()
    persistChatRightSidebar()
  })

  watch(isMobile, (mobile, wasMobile) => {
    if (wasMobile && !mobile) {
      if (isActivityPubRoute()) restoreActivityPubRightSidebar()
      else if (isChatRoute()) restoreChatRightSidebar()
    }
  })

  const toggleLeftSidebar = () => {
    if (isMobile.value) {
      rightSidebarOpen.value = false
    }
    leftSidebarOpen.value = !leftSidebarOpen.value
    if (!leftSidebarOpen.value) {
      mobileProfileOpen.value = false
    }
  }

  const toggleRightSidebar = () => {
    // No right sidebar on DM routes; ignoring avoids stranding state that
    // would trigger the mobile overlay blur.
    if (!hasRightSidebar.value) return
    if (isMobile.value) {
      leftSidebarOpen.value = false
    }
    rightSidebarOpen.value = !rightSidebarOpen.value
  }

  const toggleVoicePanel = () => {
    voicePanelOpen.value = !voicePanelOpen.value
  }

  const toggleMobileProfile = () => {
    debug.log('toggleMobileProfile called, current state:', mobileProfileOpen.value)
    mobileProfileOpen.value = !mobileProfileOpen.value
    debug.log('toggleMobileProfile new state:', mobileProfileOpen.value)
  }

  const closeMobileSidebars = () => {
    if (!isMobile.value) return
    leftSidebarOpen.value = false
    rightSidebarOpen.value = false
    mobileProfileOpen.value = false
  }

  const openLeftSidebar = () => {
    if (isMobile.value) {
      rightSidebarOpen.value = false
    }
    leftSidebarOpen.value = true
  }

  const openRightSidebar = () => {
    if (!hasRightSidebar.value) return
    if (isMobile.value) {
      leftSidebarOpen.value = false
    }
    rightSidebarOpen.value = true
  }

  const closeLeftSidebar = () => {
    leftSidebarOpen.value = false
    mobileProfileOpen.value = false
  }

  const closeRightSidebar = () => {
    rightSidebarOpen.value = false
  }

  // ===== DRAG GESTURE FUNCTIONS =====
  
  const startDrag = (direction: 'left' | 'right') => {
    // Right-edge drag would reveal a non-existent right sidebar on DM routes.
    if (direction === 'right' && !hasRightSidebar.value) return
    isDragging.value = true
    dragDirection.value = direction
    
    // Initial state decides whether the gesture opens or closes.
    if (direction === 'left') {
      leftSidebarWasOpen.value = leftSidebarOpen.value
      leftSidebarDragOffset.value = leftSidebarOpen.value ? SIDEBAR_WIDTH : 0
      rightSidebarOpen.value = false // Close other sidebar
    } else {
      rightSidebarWasOpen.value = rightSidebarOpen.value
      rightSidebarDragOffset.value = rightSidebarOpen.value ? SIDEBAR_WIDTH : 0
      leftSidebarOpen.value = false // Close other sidebar
    }
    
    debug.log('startDrag:', { 
      direction, 
      leftWasOpen: leftSidebarWasOpen.value, 
      rightWasOpen: rightSidebarWasOpen.value 
    })
  }

  const updateDragOffset = (deltaX: number, direction: 'left' | 'right') => {
    if (!isDragging.value) return
    
    if (direction === 'left') {
      // Left sidebar: +deltaX opens, -deltaX closes.
      let newOffset: number
      if (leftSidebarWasOpen.value) {
        // Started open: offset shrinks as deltaX goes negative.
        newOffset = SIDEBAR_WIDTH + deltaX
      } else {
        // Started closed: offset grows with positive deltaX.
        newOffset = deltaX
      }
      leftSidebarDragOffset.value = Math.max(0, Math.min(SIDEBAR_WIDTH, newOffset))
    } else {
      // Right sidebar: -deltaX opens, +deltaX closes.
      let newOffset: number
      if (rightSidebarWasOpen.value) {
        // Started open: offset shrinks as deltaX goes positive.
        newOffset = SIDEBAR_WIDTH - deltaX
      } else {
        // Started closed: offset grows with negative deltaX.
        newOffset = -deltaX
      }
      rightSidebarDragOffset.value = Math.max(0, Math.min(SIDEBAR_WIDTH, newOffset))
    }
  }

  // Final state is decided by drag position alone; see endDragWithVelocity for
  // the flick-aware variant.
  const endDrag = (direction: 'left' | 'right') => {
    const COMPLETION_THRESHOLD = 0.4 // fraction of SIDEBAR_WIDTH
    
    if (direction === 'left') {
      const progress = leftSidebarDragOffset.value / SIDEBAR_WIDTH
      const shouldBeOpen = progress > COMPLETION_THRESHOLD
      
      debug.log('endDrag left:', { 
        progress, 
        wasOpen: leftSidebarWasOpen.value, 
        shouldBeOpen 
      })
      
      leftSidebarOpen.value = shouldBeOpen
      if (!shouldBeOpen) {
        mobileProfileOpen.value = false
      }
    } else {
      const progress = rightSidebarDragOffset.value / SIDEBAR_WIDTH
      const shouldBeOpen = progress > COMPLETION_THRESHOLD
      
      debug.log('endDrag right:', { 
        progress, 
        wasOpen: rightSidebarWasOpen.value, 
        shouldBeOpen 
      })
      
      rightSidebarOpen.value = shouldBeOpen
    }
    
    isDragging.value = false
    dragDirection.value = null
    leftSidebarDragOffset.value = 0
    rightSidebarDragOffset.value = 0
    leftSidebarWasOpen.value = false
    rightSidebarWasOpen.value = false
  }

  // velocity is px/ms; positive = swipe right, negative = swipe left.
  const endDragWithVelocity = (velocity: number, direction: 'left' | 'right') => {
    const COMPLETION_THRESHOLD = 0.4 // fraction of SIDEBAR_WIDTH
    const VELOCITY_THRESHOLD = 0.3 // px/ms
    
    if (direction === 'left') {
      const progress = leftSidebarDragOffset.value / SIDEBAR_WIDTH
      
      let shouldBeOpen: boolean
      if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
        // Flick: direction wins over position. Rightward opens the left sidebar.
        shouldBeOpen = velocity > 0
      } else {
        // Slow drag: position threshold decides.
        shouldBeOpen = progress > COMPLETION_THRESHOLD
      }
      
      debug.log('endDragWithVelocity left:', { 
        velocity, 
        progress, 
        wasOpen: leftSidebarWasOpen.value, 
        shouldBeOpen 
      })
      
      leftSidebarOpen.value = shouldBeOpen
      if (!shouldBeOpen) {
        mobileProfileOpen.value = false
      }
    } else {
      const progress = rightSidebarDragOffset.value / SIDEBAR_WIDTH
      
      let shouldBeOpen: boolean
      if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
        // Flick: leftward opens the right sidebar.
        shouldBeOpen = velocity < 0
      } else {
        shouldBeOpen = progress > COMPLETION_THRESHOLD
      }
      
      debug.log('endDragWithVelocity right:', { 
        velocity, 
        progress, 
        wasOpen: rightSidebarWasOpen.value, 
        shouldBeOpen 
      })
      
      rightSidebarOpen.value = shouldBeOpen
    }
    
    isDragging.value = false
    dragDirection.value = null
    leftSidebarDragOffset.value = 0
    rightSidebarDragOffset.value = 0
    leftSidebarWasOpen.value = false
    rightSidebarWasOpen.value = false
  }

  const cancelDrag = () => {
    // Restore the pre-drag state.
    if (dragDirection.value === 'left') {
      leftSidebarOpen.value = leftSidebarWasOpen.value
    } else if (dragDirection.value === 'right') {
      rightSidebarOpen.value = rightSidebarWasOpen.value
    }
    
    isDragging.value = false
    dragDirection.value = null
    leftSidebarDragOffset.value = 0
    rightSidebarDragOffset.value = 0
    leftSidebarWasOpen.value = false
    rightSidebarWasOpen.value = false
  }

  const leftSidebarDragStyle = computed(() => {
    if (!isMobile.value) return {}
    
    if (isDragging.value && dragDirection.value === 'left') {
      // Left sidebar translateX: -SIDEBAR_WIDTH closed, 0 open.
      const translateX = leftSidebarDragOffset.value - SIDEBAR_WIDTH
      return {
        transform: `translateX(${translateX}px)`,
        transition: 'none'
      }
    }
    
    return {}
  })

  const rightSidebarDragStyle = computed(() => {
    if (!isMobile.value) return {}
    
    if (isDragging.value && dragDirection.value === 'right') {
      // Right sidebar translateX: SIDEBAR_WIDTH closed, 0 open.
      const translateX = SIDEBAR_WIDTH - rightSidebarDragOffset.value
      return {
        transform: `translateX(${translateX}px)`,
        transition: 'none'
      }
    }
    
    return {}
  })

  // Server sidebar sits left of the channel sidebar and slides with it on mobile.
  const serverSidebarDragStyle = computed(() => {
    if (!isMobile.value) return {}
    
    if (isDragging.value && dragDirection.value === 'left') {
      const translateX = leftSidebarDragOffset.value - SIDEBAR_WIDTH
      return {
        transform: `translateX(${translateX}px)`,
        transition: 'none'
      }
    }
    
    return {}
  })

  return {
    // Reactive state
    leftSidebarOpen: computed(() => leftSidebarOpen.value),
    rightSidebarOpen: computed(() => rightSidebarOpen.value),
    hasRightSidebar,
    voicePanelOpen: computed(() => voicePanelOpen.value),
    mobileProfileOpen: computed(() => mobileProfileOpen.value),
    isMobile: computed(() => isMobile.value),

    // Drag state
    isDragging: computed(() => isDragging.value),
    dragDirection: computed(() => dragDirection.value),
    leftSidebarDragOffset: computed(() => leftSidebarDragOffset.value),
    rightSidebarDragOffset: computed(() => rightSidebarDragOffset.value),
    
    // Pre-drag state
    leftSidebarWasOpen: computed(() => leftSidebarWasOpen.value),
    rightSidebarWasOpen: computed(() => rightSidebarWasOpen.value),

    // Drag styles for components
    leftSidebarDragStyle,
    rightSidebarDragStyle,
    serverSidebarDragStyle,

    // Configuration
    SIDEBAR_WIDTH,
    SERVER_SIDEBAR_WIDTH,

    toggleLeftSidebar,
    toggleRightSidebar,
    toggleVoicePanel,
    toggleMobileProfile,
    closeMobileSidebars,
    openLeftSidebar,
    openRightSidebar,
    closeLeftSidebar,
    closeRightSidebar,

    // Drag functions
    startDrag,
    updateDragOffset,
    endDrag,
    endDragWithVelocity,
    cancelDrag,

    // Utility functions
    checkMobileDevice
  }
}
