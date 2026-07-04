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
    swipeThreshold: 50,         // Reduced for easier activation
    directionThreshold: 12,      // Slightly reduced for faster response
    edgeZone: 80,               // Expanded from 30px for easier sidebar activation
    velocityThreshold: 0.25,    // px/ms for quick flick (lowered for easier trigger)
    sidebarWidth: 280,
    completionThreshold: 0.35   // 35% to auto-complete (easier to complete)
  }

  // Raw deltaX from start position
  const deltaX = computed(() => {
    return touchState.value.currentX - touchState.value.startX
  })

  // Calculate instantaneous velocity (px/ms)
  // eslint-disable-next-line unused-imports/no-unused-vars
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

    if (!touchState.value.initialDirection && (Math.abs(currentDeltaX) > 10 || Math.abs(currentDeltaY) > 10)) {
      touchState.value.initialDirection = Math.abs(currentDeltaX) > Math.abs(currentDeltaY) ? 'horizontal' : 'vertical'
    }

    const timeDelta = prevTime - touchState.value.lastMoveTime
    const instantVelocity = timeDelta > 0 ? Math.abs(currentDeltaX - (touchState.value.currentX - touchState.value.startX)) / timeDelta : 0
    const isFastHorizontalSwipe = instantVelocity > config.velocityThreshold * 1.2 && 
                                   Math.abs(currentDeltaX) > Math.abs(currentDeltaY) * 2

    // Handle swipes from edge zones, when sidebars are open, OR with fast horizontal velocity
    const shouldHandleSwipe = touchState.value.isEdgeSwipe || hasOpenSidebars || isFastHorizontalSwipe

    if (touchState.value.initialDirection === 'horizontal' && 
        shouldHandleSwipe && 
        Math.abs(currentDeltaX) > config.directionThreshold) {
      event.preventDefault() // Prevent scrolling
      
      if (!touchState.value.isDragging) {
        touchState.value.isDragging = true
        
        if (!touchState.value.dragDirection) {
          if (touchState.value.startX <= config.edgeZone) {
            touchState.value.dragDirection = 'left'
          } else if (typeof window !== 'undefined' && touchState.value.startX >= window.innerWidth - config.edgeZone) {
            touchState.value.dragDirection = 'right'
          } else if (hasOpenSidebars || isFastHorizontalSwipe) {
            // Determine direction based on swipe movement
            // Swiping left → closing left sidebar or opening right sidebar
            // Swiping right → opening left sidebar or closing right sidebar
            touchState.value.dragDirection = currentDeltaX < 0 ? 'left' : 'right'
          }
        }
        
        if (callbacks?.onDragStart && touchState.value.dragDirection) {
          callbacks.onDragStart(touchState.value.dragDirection)
        }
      }
      
      touchState.value.lastMoveTime = prevTime
      touchState.value.lastMoveX = prevX
      
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

    if (touchState.value.isDragging && direction) {
      if (callbacks.onDragEnd) {
        callbacks.onDragEnd(velocity, direction)
      }
    } else {
      // Enhanced swipe detection - works from edge zone OR with fast velocity from anywhere
      const absVelocity = Math.abs(velocity)
      const isFastSwipe = absVelocity > config.velocityThreshold * 1.5 // Higher velocity threshold for anywhere swipes
      // eslint-disable-next-line unused-imports/no-unused-vars
      const isFromEdge = touchState.value.startX <= config.edgeZone || 
                         (typeof window !== 'undefined' && touchState.value.startX >= window.innerWidth - config.edgeZone)
      
      if (touchState.value.initialDirection === 'horizontal' && 
          (Math.abs(finalDeltaX) > config.swipeThreshold || absVelocity > config.velocityThreshold) && 
          Math.abs(finalDeltaY) < 100) {
        
        if (finalDeltaX > 0) {
          // Swipe right - open left sidebar
          // Works from left edge zone OR with fast velocity from anywhere
          if (touchState.value.startX <= config.edgeZone || isFastSwipe) {
            callbacks.onSwipeRight()
          }
        } else {
          // Swipe left - open right sidebar
          // Works from right edge zone OR with fast velocity from anywhere
          if ((typeof window !== 'undefined' && touchState.value.startX >= window.innerWidth - config.edgeZone) || isFastSwipe) {
            callbacks.onSwipeLeft()
          }
        }
      }
    }

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
