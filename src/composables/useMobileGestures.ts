import { ref, computed } from 'vue'

interface TouchState {
  startX: number
  startY: number
  currentX: number
  currentY: number
  isDragging: boolean
  initialDirection: 'horizontal' | 'vertical' | null
  isEdgeSwipe: boolean
  startTime: number
}

interface SwipeConfig {
  swipeThreshold: number
  directionThreshold: number
  edgeZone: number
  velocityThreshold: number
}

export function useMobileGestures() {
  const touchState = ref<TouchState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    isDragging: false,
    initialDirection: null,
    isEdgeSwipe: false,
    startTime: 0
  })

  const config: SwipeConfig = {
    swipeThreshold: 60,
    directionThreshold: 20,
    edgeZone: 25,
    velocityThreshold: 0.3
  }

  const swipeProgress = computed(() => {
    if (!touchState.value.isDragging) return 0
    const deltaX = touchState.value.currentX - touchState.value.startX
    return Math.max(0, Math.min(1, Math.abs(deltaX) / config.swipeThreshold))
  })

  const handleTouchStart = (event: TouchEvent, isMobile: boolean) => {
    if (!isMobile || typeof window === 'undefined') return

    const touch = event.touches[0]
    const windowWidth = window.innerWidth
    const isLeftEdge = touch.clientX <= config.edgeZone
    const isRightEdge = touch.clientX >= windowWidth - config.edgeZone

    touchState.value = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      isDragging: false,
      initialDirection: null,
      isEdgeSwipe: isLeftEdge || isRightEdge,
      startTime: Date.now()
    }
  }

  const handleTouchMove = (event: TouchEvent, isMobile: boolean, hasOpenSidebars: boolean) => {
    if (!isMobile || !touchState.value) return

    const touch = event.touches[0]
    touchState.value.currentX = touch.clientX
    touchState.value.currentY = touch.clientY

    const deltaX = touch.clientX - touchState.value.startX
    const deltaY = touch.clientY - touchState.value.startY

    // Determine initial direction if not set
    if (!touchState.value.initialDirection && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
      touchState.value.initialDirection = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
    }

    // Only handle horizontal swipes for sidebar control when it's an edge swipe or sidebar is already open
    const shouldHandleSwipe = touchState.value.isEdgeSwipe || hasOpenSidebars

    if (touchState.value.initialDirection === 'horizontal' && 
        shouldHandleSwipe && 
        Math.abs(deltaX) > config.directionThreshold) {
      event.preventDefault() // Prevent scrolling
      touchState.value.isDragging = true
    }
  }

  const handleTouchEnd = (
    event: TouchEvent, 
    isMobile: boolean,
    callbacks: {
      onSwipeRight: () => void
      onSwipeLeft: () => void
    }
  ) => {
    if (!isMobile || !touchState.value) return

    const touch = event.changedTouches[0]
    const deltaX = touch.clientX - touchState.value.startX
    const deltaY = touch.clientY - touchState.value.startY
    const duration = Date.now() - touchState.value.startTime
    const velocity = Math.abs(deltaX) / duration

    // Only process horizontal swipes with enough distance or velocity
    if (touchState.value.initialDirection === 'horizontal' && 
        (Math.abs(deltaX) > config.swipeThreshold || velocity > config.velocityThreshold) && 
        Math.abs(deltaY) < 100) {
      
      if (deltaX > 0) {
        // Swipe right
        if (touchState.value.startX <= config.edgeZone) {
          callbacks.onSwipeRight()
        }
      } else {
        // Swipe left  
        if (typeof window !== 'undefined' && touchState.value.startX >= window.innerWidth - config.edgeZone) {
          callbacks.onSwipeLeft()
        }
      }
    }

    // Reset touch state
    touchState.value = {
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      isDragging: false,
      initialDirection: null,
      isEdgeSwipe: false,
      startTime: 0
    }
  }

  const resetTouchState = () => {
    touchState.value = {
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      isDragging: false,
      initialDirection: null,
      isEdgeSwipe: false,
      startTime: 0
    }
  }

  return {
    touchState,
    swipeProgress,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    resetTouchState
  }
}
