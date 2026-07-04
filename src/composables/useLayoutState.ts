import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { debug } from '@/utils/debug'

const STORAGE_KEY_ACTIVITYPUB_RIGHT_SIDEBAR = 'harmony_activitypub_right_sidebar_open'
// Server chat (member list) right sidebar is remembered independently from the
// ActivityPub right sidebar, so collapsing one context doesn't collapse the
// other - and bouncing through a DM (which has no right sidebar) no longer
// leaves the chat member list stuck collapsed.
const STORAGE_KEY_CHAT_RIGHT_SIDEBAR = 'harmony_chat_right_sidebar_open'

// Global layout state
const leftSidebarOpen = ref(false)
const rightSidebarOpen = ref(false)
const voicePanelOpen = ref(false)
const profileOpen = ref(false)
const mobileProfileOpen = ref(false)
const isMobile = ref(false)

// Mobile drag state for native-feeling gestures
const isDragging = ref(false)
const dragDirection = ref<'left' | 'right' | null>(null)
const leftSidebarDragOffset = ref(0)
const rightSidebarDragOffset = ref(0)

const leftSidebarWasOpen = ref(false)
const rightSidebarWasOpen = ref(false)

// Sidebar configuration
const SIDEBAR_WIDTH = 280
const SERVER_SIDEBAR_WIDTH = 72

// Mobile detection
//
// only mutate sidebar state on *transitions* (desktop⇄mobile) and on
// first mount. Every keystroke on mobile triggers a `resize` event because the
// soft keyboard changes viewport height - if we closed sidebars on every call,
// the DM search input would dismiss its own surrounding sidebar mid-typing.
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

// Resize handler
const handleResize = () => {
  checkMobileDevice()
}

export function useLayoutState() {
  const route = useRoute()

  const isActivityPubRoute = (): boolean => {
    const p = route.path
    return p.startsWith('/social') || p.startsWith('/posts')
  }

  // DM routes have no right sidebar (no member/details panel). Used to suppress
  // the right-sidebar toggle/gesture/overlay so the mobile backdrop blur never
  // appears on a screen that has nothing to reveal.
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
    // Default to open (member list visible) on first run, matching desktop default.
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

  // Restore ActivityPub right sidebar when navigating to social/posts
  watch(
    () => route.path,
    (path) => {
      // DM has no right sidebar - collapse it so the mobile backdrop blur
      // doesn't linger over a panel-less screen. The chat member-list state is
      // preserved in localStorage and restored when returning to /chat.
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

  // Persist whichever context's right sidebar was just toggled. Each persist
  // helper guards on its own route, so the active context is the only one saved.
  watch(rightSidebarOpen, () => {
    persistActivityPubRightSidebar()
    persistChatRightSidebar()
  })

  // Restore the active context's right sidebar when resizing from mobile to desktop
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
    // No right sidebar exists on DM routes; ignore so we don't strand state
    // that would trigger the mobile overlay blur.
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
    debug.log('🔄 toggleMobileProfile called, current state:', mobileProfileOpen.value)
    mobileProfileOpen.value = !mobileProfileOpen.value
    debug.log('🔄 toggleMobileProfile new state:', mobileProfileOpen.value)
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
  
  /**
   * Start a drag operation for native-feeling sidebar gestures
   * Tracks initial state to determine if we're opening or closing
   */
  const startDrag = (direction: 'left' | 'right') => {
    // Right-edge drag would reveal a non-existent right sidebar on DM routes.
    if (direction === 'right' && !hasRightSidebar.value) return
    isDragging.value = true
    dragDirection.value = direction
    
    // Remember initial state to determine open/close behavior
    if (direction === 'left') {
      leftSidebarWasOpen.value = leftSidebarOpen.value
      leftSidebarDragOffset.value = leftSidebarOpen.value ? SIDEBAR_WIDTH : 0
      rightSidebarOpen.value = false // Close other sidebar
    } else {
      rightSidebarWasOpen.value = rightSidebarOpen.value
      rightSidebarDragOffset.value = rightSidebarOpen.value ? SIDEBAR_WIDTH : 0
      leftSidebarOpen.value = false // Close other sidebar
    }
    
    debug.log('📱 startDrag:', { 
      direction, 
      leftWasOpen: leftSidebarWasOpen.value, 
      rightWasOpen: rightSidebarWasOpen.value 
    })
  }

  /**
   * Update drag offset during touch move
   * Now properly handles both opening and closing
   */
  const updateDragOffset = (deltaX: number, direction: 'left' | 'right') => {
    if (!isDragging.value) return
    
    if (direction === 'left') {
      // Left sidebar: opening = drag right (+deltaX), closing = drag left (-deltaX)
      let newOffset: number
      if (leftSidebarWasOpen.value) {
        // Was open, so we're potentially closing
        // deltaX negative = closing, positive = no change (already open)
        newOffset = SIDEBAR_WIDTH + deltaX
      } else {
        // Was closed, so we're potentially opening
        // deltaX positive = opening
        newOffset = deltaX
      }
      leftSidebarDragOffset.value = Math.max(0, Math.min(SIDEBAR_WIDTH, newOffset))
    } else {
      // Right sidebar: opening = drag left (-deltaX), closing = drag right (+deltaX)
      let newOffset: number
      if (rightSidebarWasOpen.value) {
        // Was open, so we're potentially closing
        // deltaX positive = closing
        newOffset = SIDEBAR_WIDTH - deltaX
      } else {
        // Was closed, so we're potentially opening
        // deltaX negative = opening
        newOffset = -deltaX
      }
      rightSidebarDragOffset.value = Math.max(0, Math.min(SIDEBAR_WIDTH, newOffset))
    }
  }

  /**
   * End drag operation and determine final state based on current offset
   * Uses threshold to decide whether to complete or cancel the gesture
   */
  const endDrag = (direction: 'left' | 'right') => {
    const COMPLETION_THRESHOLD = 0.4 // 40% threshold
    
    if (direction === 'left') {
      const progress = leftSidebarDragOffset.value / SIDEBAR_WIDTH
      // If we dragged past the threshold, toggle the state
      // If was closed and progress > threshold → open
      // If was open and progress < threshold → close
      const shouldBeOpen = progress > COMPLETION_THRESHOLD
      
      debug.log('📱 endDrag left:', { 
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
      
      debug.log('📱 endDrag right:', { 
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

  /**
   * End drag with velocity consideration
   * @param velocity - The velocity of the swipe (px/ms), positive = right, negative = left
   * @param direction - Which sidebar was being dragged
   */
  const endDragWithVelocity = (velocity: number, direction: 'left' | 'right') => {
    const COMPLETION_THRESHOLD = 0.4 // 40% position threshold
    const VELOCITY_THRESHOLD = 0.3 // px/ms velocity threshold
    
    if (direction === 'left') {
      const progress = leftSidebarDragOffset.value / SIDEBAR_WIDTH
      
      let shouldBeOpen: boolean
      if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
        // Fast swipe - use velocity direction
        // Positive velocity (swipe right) = open, negative = close
        shouldBeOpen = velocity > 0
      } else {
        // Slow drag - use position threshold
        shouldBeOpen = progress > COMPLETION_THRESHOLD
      }
      
      debug.log('📱 endDragWithVelocity left:', { 
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
        // Fast swipe - negative velocity (swipe left) = open right sidebar
        shouldBeOpen = velocity < 0
      } else {
        shouldBeOpen = progress > COMPLETION_THRESHOLD
      }
      
      debug.log('📱 endDragWithVelocity right:', { 
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

  /**
   * Cancel drag and restore previous state
   */
  const cancelDrag = () => {
    // Restore to initial state
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

  // Computed styles for real-time drag transforms
  const leftSidebarDragStyle = computed(() => {
    if (!isMobile.value) return {}
    
    if (isDragging.value && dragDirection.value === 'left') {
      // During drag: apply direct transform based on offset
      // Left sidebar slides from -SIDEBAR_WIDTH (closed) to 0 (open)
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
      // During drag: apply direct transform based on offset
      // Right sidebar slides from SIDEBAR_WIDTH (closed) to 0 (open)
      const translateX = SIDEBAR_WIDTH - rightSidebarDragOffset.value
      return {
        transform: `translateX(${translateX}px)`,
        transition: 'none'
      }
    }
    
    return {}
  })

  // Server sidebar (always on left, slides with channel sidebar on mobile)
  const serverSidebarDragStyle = computed(() => {
    if (!isMobile.value) return {}
    
    if (isDragging.value && dragDirection.value === 'left') {
      // Server sidebar follows the left sidebar drag
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
    
    // Initial state tracking (for components that need it)
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
