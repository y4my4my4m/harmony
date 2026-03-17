import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'

const TIMELINE_ORDER = ['home', 'local', 'public', 'trending', 'instances'] as const
type TimelineId = typeof TIMELINE_ORDER[number]

const ROUTE_NAMES: Record<TimelineId, string> = {
  home: 'SocialHome',
  local: 'SocialLocal',
  public: 'SocialPublic',
  trending: 'SocialTrending',
  instances: 'SocialInstances',
}

interface SwipeState {
  startX: number
  startY: number
  currentX: number
  isDragging: boolean
  directionLocked: 'horizontal' | 'vertical' | null
  startTime: number
}

const SWIPE_THRESHOLD = 60
const VELOCITY_THRESHOLD = 0.3
const DIRECTION_LOCK_THRESHOLD = 10

export function useTimelineSwipe(options: {
  isMobile: () => boolean
  leftSidebarOpen: () => boolean
  rightSidebarOpen: () => boolean
  toggleLeftSidebar: () => void
  toggleRightSidebar: () => void
}) {
  const router = useRouter()
  const route = useRoute()

  const swipeState = ref<SwipeState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    isDragging: false,
    directionLocked: null,
    startTime: 0,
  })

  const swipeOffset = ref(0)
  const isTransitioning = ref(false)

  const currentTimeline = computed((): TimelineId | null => {
    const name = route.name as string
    for (const [id, routeName] of Object.entries(ROUTE_NAMES)) {
      if (routeName === name) return id as TimelineId
    }
    return null
  })

  const currentIndex = computed(() => {
    if (!currentTimeline.value) return -1
    return TIMELINE_ORDER.indexOf(currentTimeline.value)
  })

  function navigateTo(direction: 'left' | 'right') {
    const idx = currentIndex.value

    if (direction === 'right') {
      // Swipe right = go to previous or open left sidebar
      if (idx <= 0) {
        if (!options.leftSidebarOpen()) {
          options.toggleLeftSidebar()
        }
        return
      }
      const target = TIMELINE_ORDER[idx - 1]
      router.push({ name: ROUTE_NAMES[target] })
    } else {
      // Swipe left = go to next or open right sidebar
      if (idx === -1) return
      if (idx >= TIMELINE_ORDER.length - 1) {
        if (!options.rightSidebarOpen()) {
          options.toggleRightSidebar()
        }
        return
      }
      const target = TIMELINE_ORDER[idx + 1]
      router.push({ name: ROUTE_NAMES[target] })
    }
  }

  function onTouchStart(e: TouchEvent) {
    if (!options.isMobile()) return
    if (options.leftSidebarOpen() || options.rightSidebarOpen()) return
    if (isTransitioning.value) return

    const touch = e.touches[0]
    swipeState.value = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      isDragging: false,
      directionLocked: null,
      startTime: Date.now(),
    }
    swipeOffset.value = 0
  }

  function onTouchMove(e: TouchEvent) {
    if (!options.isMobile()) return
    if (options.leftSidebarOpen() || options.rightSidebarOpen()) return
    const state = swipeState.value
    if (state.startX === 0 && state.startY === 0) return

    const touch = e.touches[0]
    const deltaX = touch.clientX - state.startX
    const deltaY = touch.clientY - state.startY

    if (!state.directionLocked) {
      if (Math.abs(deltaX) > DIRECTION_LOCK_THRESHOLD || Math.abs(deltaY) > DIRECTION_LOCK_THRESHOLD) {
        state.directionLocked = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
      }
    }

    if (state.directionLocked !== 'horizontal') return
    if (currentIndex.value === -1) return

    const atStart = currentIndex.value === 0 && deltaX > 0
    const atEnd = currentIndex.value === TIMELINE_ORDER.length - 1 && deltaX < 0

    // Apply resistance at edges
    const resistance = (atStart || atEnd) ? 0.3 : 1
    swipeOffset.value = deltaX * resistance
    state.currentX = touch.clientX
    state.isDragging = true
  }

  function onTouchEnd() {
    if (!options.isMobile()) return
    const state = swipeState.value
    if (!state.isDragging || state.directionLocked !== 'horizontal') {
      resetState()
      return
    }

    const deltaX = state.currentX - state.startX
    const duration = Date.now() - state.startTime
    const velocity = Math.abs(deltaX) / Math.max(duration, 1)

    if (Math.abs(deltaX) > SWIPE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
      isTransitioning.value = true
      navigateTo(deltaX > 0 ? 'right' : 'left')
      setTimeout(() => {
        isTransitioning.value = false
      }, 350)
    }

    resetState()
  }

  function resetState() {
    swipeState.value = {
      startX: 0,
      startY: 0,
      currentX: 0,
      isDragging: false,
      directionLocked: null,
      startTime: 0,
    }
    swipeOffset.value = 0
  }

  return {
    swipeOffset,
    isDragging: computed(() => swipeState.value.isDragging),
    currentTimeline,
    currentIndex,
    timelineOrder: TIMELINE_ORDER,
    navigateTo,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  }
}
