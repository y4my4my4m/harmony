import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

// Global layout state
const leftSidebarOpen = ref(false)
const rightSidebarOpen = ref(false)
const voicePanelOpen = ref(false)
const isMobile = ref(false)

// Mobile detection
const checkMobileDevice = () => {
  const wasMobile = isMobile.value
  isMobile.value = typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  
  if (isMobile.value) {
    leftSidebarOpen.value = false
    rightSidebarOpen.value = false
  } else {
    if (!wasMobile || !leftSidebarOpen.value) {
      leftSidebarOpen.value = true
    }
    rightSidebarOpen.value = false
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

  const closeMobileSidebars = () => {
    leftSidebarOpen.value = false
    rightSidebarOpen.value = false
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
  }

  const closeRightSidebar = () => {
    rightSidebarOpen.value = false
  }

  return {
    // Reactive state
    leftSidebarOpen: computed(() => leftSidebarOpen.value),
    rightSidebarOpen: computed(() => rightSidebarOpen.value),
    voicePanelOpen: computed(() => voicePanelOpen.value),
    isMobile: computed(() => isMobile.value),

    // Toggle functions
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleVoicePanel,
    closeMobileSidebars,
    openLeftSidebar,
    openRightSidebar,
    closeLeftSidebar,
    closeRightSidebar,

    // Utility functions
    checkMobileDevice
  }
}