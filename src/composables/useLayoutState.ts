import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { debug } from '@/utils/debug'

// Global layout state
const leftSidebarOpen = ref(false)
const rightSidebarOpen = ref(false)
const voicePanelOpen = ref(false)
const profileOpen = ref(false)
const mobileProfileOpen = ref(false)
const isMobile = ref(false)

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

  return {
    // Reactive state
    leftSidebarOpen: computed(() => leftSidebarOpen.value),
    rightSidebarOpen: computed(() => rightSidebarOpen.value),
    voicePanelOpen: computed(() => voicePanelOpen.value),
    mobileProfileOpen: computed(() => mobileProfileOpen.value),
    isMobile: computed(() => isMobile.value),

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

    // Utility functions
    checkMobileDevice
  }
}