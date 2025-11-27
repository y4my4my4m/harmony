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
  dragDirection: 'left' | 'right' | null
  lastMoveTime: number
  lastMoveX: number
}

interface SwipeConfig {
  swipeThreshold: number
  directionThreshold: number
  edgeZone: number
  velocityThreshold: number
  sidebarWidth: number
  completionThreshold: number
}

interface DragCallbacks {
  onSwipeRight: () => void
  onSwipeLeft: () => void
  onDragStart?: (direction: 'left' | 'right') => void
  onDragMove?: (deltaX: number, direction: 'left' | 'right') => void
  onDragEnd?: (velocity: number, direction: 'left' | 'right') => void
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
    startTime: 0,
    dragDirection: null,
    lastMoveTime: 0,
    lastMoveX: 0
  })

  const config: SwipeConfig = {
    swipeThreshold: 60,
    directionThreshold: 15,
    edgeZone: 30,
    velocityThreshold: 0.3, // px/ms for quick flick
    sidebarWidth: 280,
    completionThreshold: 0.4 // 40% to auto-complete
  }

  // Raw deltaX from start position
  const deltaX = computed(() => {
    return touchState.value.currentX - touchState.value.startX
  })

  // Calculate instantaneous velocity (px/ms)
  const getVelocity = () => {
    const now = Date.now()
    const timeDelta = now - touchState.value.lastMoveTime
    if (timeDelta === 0 || timeDelta > 100) return 0 // Ignore if too old
    const posDelta = touchState.value.currentX - touchState.value.lastMoveX
    return posDelta / timeDelta
  }

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
      startTime: Date.now(),
      dragDirection: isLeftEdge ? 'left' : isRightEdge ? 'right' : null,
      lastMoveTime: Date.now(),
      lastMoveX: touch.clientX
    }
  }

  const handleTouchMove = (
    event: TouchEvent, 
    isMobile: boolean, 
    hasOpenSidebars: boolean,
    callbacks?: DragCallbacks
  ) => {
    if (!isMobile || !touchState.value) return

    const touch = event.touches[0]
    const prevX = touchState.value.currentX
    const prevTime = Date.now()
    
    touchState.value.currentX = touch.clientX
    touchState.value.currentY = touch.clientY

    const currentDeltaX = touch.clientX - touchState.value.startX
    const currentDeltaY = touch.clientY - touchState.value.startY

    // Determine initial direction if not set
    if (!touchState.value.initialDirection && (Math.abs(currentDeltaX) > 10 || Math.abs(currentDeltaY) > 10)) {
      touchState.value.initialDirection = Math.abs(currentDeltaX) > Math.abs(currentDeltaY) ? 'horizontal' : 'vertical'
    }

    // Only handle horizontal swipes for sidebar control when it's an edge swipe or sidebar is already open
    const shouldHandleSwipe = touchState.value.isEdgeSwipe || hasOpenSidebars

    if (touchState.value.initialDirection === 'horizontal' && 
        shouldHandleSwipe && 
        Math.abs(currentDeltaX) > config.directionThreshold) {
      event.preventDefault() // Prevent scrolling
      
      // Start dragging if not already
      if (!touchState.value.isDragging) {
        touchState.value.isDragging = true
        
        // Determine drag direction based on where touch started OR swipe direction if sidebar is open
        if (!touchState.value.dragDirection) {
          if (touchState.value.startX <= config.edgeZone) {
            touchState.value.dragDirection = 'left'
          } else if (typeof window !== 'undefined' && touchState.value.startX >= window.innerWidth - config.edgeZone) {
            touchState.value.dragDirection = 'right'
          } else if (hasOpenSidebars) {
            // If sidebar is open and we're swiping, determine which sidebar based on swipe direction
            // Swiping left when left sidebar is open → closing left sidebar
            // Swiping right when right sidebar is open → closing right sidebar
            touchState.value.dragDirection = currentDeltaX < 0 ? 'left' : 'right'
          }
        }
        
        // Notify drag start
        if (callbacks?.onDragStart && touchState.value.dragDirection) {
          callbacks.onDragStart(touchState.value.dragDirection)
        }
      }
      
      // Update velocity tracking
      touchState.value.lastMoveTime = prevTime
      touchState.value.lastMoveX = prevX
      
      // Notify drag move with raw deltaX
      if (callbacks?.onDragMove && touchState.value.dragDirection) {
        callbacks.onDragMove(currentDeltaX, touchState.value.dragDirection)
      }
    }
  }

  const handleTouchEnd = (
    event: TouchEvent, 
    isMobile: boolean,
    callbacks: DragCallbacks
  ) => {
    if (!isMobile || !touchState.value) return

    const touch = event.changedTouches[0]
    const finalDeltaX = touch.clientX - touchState.value.startX
    const finalDeltaY = touch.clientY - touchState.value.startY
    const duration = Date.now() - touchState.value.startTime
    const velocity = finalDeltaX / Math.max(duration, 1) // px/ms, positive = right, negative = left
    const direction = touchState.value.dragDirection

    // Check if we were actively dragging
    if (touchState.value.isDragging && direction) {
      // Notify drag end with velocity
      if (callbacks.onDragEnd) {
        callbacks.onDragEnd(velocity, direction)
      }
    } else {
      // Legacy behavior for non-drag swipes (quick flicks from edge)
      const absVelocity = Math.abs(velocity)
      if (touchState.value.initialDirection === 'horizontal' && 
          (Math.abs(finalDeltaX) > config.swipeThreshold || absVelocity > config.velocityThreshold) && 
          Math.abs(finalDeltaY) < 100) {
        
        if (finalDeltaX > 0) {
          // Swipe right from left edge
          if (touchState.value.startX <= config.edgeZone) {
            callbacks.onSwipeRight()
          }
        } else {
          // Swipe left from right edge
          if (typeof window !== 'undefined' && touchState.value.startX >= window.innerWidth - config.edgeZone) {
            callbacks.onSwipeLeft()
          }
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
      startTime: 0,
      dragDirection: null,
      lastMoveTime: 0,
      lastMoveX: 0
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
      startTime: 0,
      dragDirection: null,
      lastMoveTime: 0,
      lastMoveX: 0
    }
  }

  return {
    touchState,
    deltaX,
    config,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    resetTouchState
  }
}
