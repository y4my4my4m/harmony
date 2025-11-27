import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { debug } from '@/utils/debug'

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

// Sidebar configuration
const SIDEBAR_WIDTH = 280
const SERVER_SIDEBAR_WIDTH = 72

// Mobile detection
const checkMobileDevice = () => {
  const wasMobile = isMobile.value
  isMobile.value = typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  
  if (isMobile.value) {
    leftSidebarOpen.value = false
    rightSidebarOpen.value = false
    profileOpen.value = false
    mobileProfileOpen.value = false
  } else {
    if (!wasMobile || !leftSidebarOpen.value) {
      leftSidebarOpen.value = true
    }
    rightSidebarOpen.value = true
  }
}

// Resize handler
const handleResize = () => {
  checkMobileDevice()
}

export function useLayoutState() {
  // Initialize mobile detection on mount
  onMounted(() => {
    if (typeof window !== 'undefined') {
      checkMobileDevice()
      window.addEventListener('resize', handleResize)
    }
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', handleResize)
    }
  })

  // Toggle functions
  const toggleLeftSidebar = () => {
    if (isMobile.value) {
      rightSidebarOpen.value = false
    }
    leftSidebarOpen.value = !leftSidebarOpen.value
    // Close mobile profile when left sidebar is closed
    if (!leftSidebarOpen.value) {
      mobileProfileOpen.value = false
    }
  }

  const toggleRightSidebar = () => {
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
    if (isMobile.value) {
      leftSidebarOpen.value = false
    }
    rightSidebarOpen.value = true
  }

  const closeLeftSidebar = () => {
    leftSidebarOpen.value = false
    // Close mobile profile when left sidebar is closed
    mobileProfileOpen.value = false
  }

  const closeRightSidebar = () => {
    rightSidebarOpen.value = false
  }

  // ===== DRAG GESTURE FUNCTIONS =====
  
  /**
   * Start a drag operation for native-feeling sidebar gestures
   */
  const startDrag = (direction: 'left' | 'right') => {
    isDragging.value = true
    dragDirection.value = direction
    
    // Initialize offset based on current sidebar state
    if (direction === 'left') {
      leftSidebarDragOffset.value = leftSidebarOpen.value ? SIDEBAR_WIDTH : 0
      rightSidebarOpen.value = false // Close other sidebar
    } else {
      rightSidebarDragOffset.value = rightSidebarOpen.value ? SIDEBAR_WIDTH : 0
      leftSidebarOpen.value = false // Close other sidebar
    }
  }

  /**
   * Update drag offset during touch move
   */
  const updateDragOffset = (offset: number, direction: 'left' | 'right') => {
    if (!isDragging.value) return
    
    // Clamp offset between 0 and sidebar width
    const clampedOffset = Math.max(0, Math.min(SIDEBAR_WIDTH, offset))
    
    if (direction === 'left') {
      leftSidebarDragOffset.value = clampedOffset
    } else {
      rightSidebarDragOffset.value = clampedOffset
    }
  }

  /**
   * End drag operation and animate to final position
   * @param shouldOpen - Whether the sidebar should open (true) or close (false)
   * @param direction - Which sidebar was being dragged
   */
  const endDrag = (shouldOpen: boolean, direction: 'left' | 'right') => {
    isDragging.value = false
    dragDirection.value = null
    
    if (direction === 'left') {
      leftSidebarOpen.value = shouldOpen
      leftSidebarDragOffset.value = 0
      if (!shouldOpen) {
        mobileProfileOpen.value = false
      }
    } else {
      rightSidebarOpen.value = shouldOpen
      rightSidebarDragOffset.value = 0
    }
  }

  /**
   * Cancel drag and restore previous state
   */
  const cancelDrag = () => {
    isDragging.value = false
    dragDirection.value = null
    leftSidebarDragOffset.value = 0
    rightSidebarDragOffset.value = 0
  }

  // Computed styles for real-time drag transforms
  const leftSidebarDragStyle = computed(() => {
    if (!isMobile.value) return {}
    
    if (isDragging.value && dragDirection.value === 'left') {
      // During drag: apply direct transform based on offset
      // Left sidebar slides from -100% to 0 (closed to open)
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
      // Right sidebar slides from 100% to 0 (closed to open)
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
    voicePanelOpen: computed(() => voicePanelOpen.value),
    mobileProfileOpen: computed(() => mobileProfileOpen.value),
    isMobile: computed(() => isMobile.value),

    // Drag state
    isDragging: computed(() => isDragging.value),
    dragDirection: computed(() => dragDirection.value),
    leftSidebarDragOffset: computed(() => leftSidebarDragOffset.value),
    rightSidebarDragOffset: computed(() => rightSidebarDragOffset.value),

    // Drag styles for components
    leftSidebarDragStyle,
    rightSidebarDragStyle,
    serverSidebarDragStyle,

    // Configuration
    SIDEBAR_WIDTH,
    SERVER_SIDEBAR_WIDTH,

    // Toggle functions
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
    cancelDrag,

    // Utility functions
    checkMobileDevice
  }
}
