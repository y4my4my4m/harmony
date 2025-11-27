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
  onDragProgress?: (progress: number, direction: 'left' | 'right') => void
  onDragEnd?: (completed: boolean, direction: 'left' | 'right') => void
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
    velocityThreshold: 0.5, // px/ms for quick flick
    sidebarWidth: 280,
    completionThreshold: 0.4 // 40% to auto-complete
  }

  // Real-time drag progress (0 to 1)
  const dragProgress = computed(() => {
    if (!touchState.value.isDragging || !touchState.value.dragDirection) return 0
    const deltaX = touchState.value.currentX - touchState.value.startX
    const absDelta = Math.abs(deltaX)
    return Math.max(0, Math.min(1, absDelta / config.sidebarWidth))
  })

  // Raw drag offset in pixels (for inline styles)
  const dragOffset = computed(() => {
    if (!touchState.value.isDragging || !touchState.value.dragDirection) return 0
    const deltaX = touchState.value.currentX - touchState.value.startX
    
    // For left sidebar (opening with right swipe from left edge)
    if (touchState.value.dragDirection === 'left') {
      return Math.max(0, Math.min(config.sidebarWidth, deltaX))
    }
    // For right sidebar (opening with left swipe from right edge)
    if (touchState.value.dragDirection === 'right') {
      return Math.max(0, Math.min(config.sidebarWidth, -deltaX))
    }
    return 0
  })

  // Calculate instantaneous velocity (px/ms)
  const getVelocity = () => {
    const now = Date.now()
    const timeDelta = now - touchState.value.lastMoveTime
    if (timeDelta === 0) return 0
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
      
      // Start dragging if not already
      if (!touchState.value.isDragging) {
        touchState.value.isDragging = true
        
        // Determine drag direction based on where touch started
        if (!touchState.value.dragDirection) {
          if (touchState.value.startX <= config.edgeZone) {
            touchState.value.dragDirection = 'left'
          } else if (typeof window !== 'undefined' && touchState.value.startX >= window.innerWidth - config.edgeZone) {
            touchState.value.dragDirection = 'right'
          } else if (hasOpenSidebars) {
            // If sidebar is open and we're swiping to close, determine direction
            touchState.value.dragDirection = deltaX > 0 ? 'right' : 'left'
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
      
      // Notify drag progress
      if (callbacks?.onDragProgress && touchState.value.dragDirection) {
        callbacks.onDragProgress(dragProgress.value, touchState.value.dragDirection)
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
    const deltaX = touch.clientX - touchState.value.startX
    const deltaY = touch.clientY - touchState.value.startY
    const duration = Date.now() - touchState.value.startTime
    const velocity = Math.abs(deltaX) / duration
    const direction = touchState.value.dragDirection

    // Check if we were actively dragging
    if (touchState.value.isDragging && direction) {
      const progress = dragProgress.value
      
      // Determine if swipe should complete based on velocity OR position
      const shouldComplete = velocity > config.velocityThreshold || progress > config.completionThreshold
      
      // Notify drag end
      if (callbacks.onDragEnd) {
        callbacks.onDragEnd(shouldComplete, direction)
      }
      
      // Also call the legacy callbacks for backward compatibility
      if (shouldComplete) {
        if (direction === 'left') {
          callbacks.onSwipeRight()
        } else if (direction === 'right') {
          callbacks.onSwipeLeft()
        }
      }
    } else {
      // Legacy behavior for non-drag swipes (quick flicks)
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
    dragProgress,
    dragOffset,
    config,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    resetTouchState
  }
}
