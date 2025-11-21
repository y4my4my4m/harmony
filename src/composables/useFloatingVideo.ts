/**
 * Floating Video Player Composable
 * Manages floating video state for YouTube and native video elements
 */

import { ref, computed, onUnmounted } from 'vue'

interface VideoElement {
  element: HTMLElement
  originalParent: HTMLElement
  messageId: string
  type: 'youtube' | 'video'
  isPlaying: boolean
}

// Global state (singleton)
const currentFloatingVideo = ref<VideoElement | null>(null)
const floatingPosition = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const isUserSetting = ref(true) // Default: enabled

// Load user preference
if (typeof localStorage !== 'undefined') {
  const saved = localStorage.getItem('floatingVideoEnabled')
  if (saved !== null) {
    isUserSetting.value = saved === 'true'
  }
}

export function useFloatingVideo() {
  const isEnabled = computed(() => isUserSetting.value)

  /**
   * Toggle floating video feature
   */
  const setEnabled = (enabled: boolean) => {
    isUserSetting.value = enabled
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('floatingVideoEnabled', String(enabled))
    }
    
    // If disabling, clear any floating video
    if (!enabled && currentFloatingVideo.value) {
      returnToOriginalPosition()
    }
  }

  /**
   * Register a video element for floating
   */
  const registerVideo = (
    element: HTMLElement,
    originalParent: HTMLElement,
    messageId: string,
    type: 'youtube' | 'video'
  ) => {
    if (!isEnabled.value) return

    // Setup intersection observer to detect when video leaves viewport
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const isPlaying = checkIfPlaying(element, type)
          
          // If video is playing and less than 20% visible, float it
          if (isPlaying && entry.intersectionRatio < 0.2) {
            floatVideo(element, originalParent, messageId, type)
          }
          // If video is back in view and is floating, return it
          else if (entry.intersectionRatio > 0.8 && currentFloatingVideo.value?.messageId === messageId) {
            returnToOriginalPosition()
          }
        })
      },
      {
        threshold: [0, 0.2, 0.8, 1.0]
      }
    )

    observer.observe(element)

    // Cleanup on unmount
    onUnmounted(() => {
      observer.disconnect()
    })

    return observer
  }

  /**
   * Check if video is currently playing
   */
  const checkIfPlaying = (element: HTMLElement, type: 'youtube' | 'video'): boolean => {
    if (type === 'video') {
      const video = element.querySelector('video')
      return video ? !video.paused : false
    } else if (type === 'youtube') {
      // For YouTube, we need to check via postMessage API
      // This requires the iframe to have enablejsapi=1
      const iframe = element.querySelector('iframe')
      if (!iframe) return false
      
      // Check if element has data attribute tracking play state
      return element.dataset.isPlaying === 'true'
    }
    return false
  }

  /**
   * Float the video to top-right corner
   */
  const floatVideo = (
    element: HTMLElement,
    originalParent: HTMLElement,
    messageId: string,
    type: 'youtube' | 'video'
  ) => {
    // If another video is already floating, return it first
    if (currentFloatingVideo.value && currentFloatingVideo.value.messageId !== messageId) {
      returnToOriginalPosition()
    }

    currentFloatingVideo.value = {
      element,
      originalParent,
      messageId,
      type,
      isPlaying: true
    }

    // Calculate initial position (top-right corner)
    const windowWidth = window.innerWidth
    const videoWidth = Math.min(400, windowWidth * 0.9)
    const videoHeight = Math.min(225, videoWidth * 9 / 16)
    
    floatingPosition.value = {
      x: windowWidth - videoWidth - 20,
      y: 80
    }

    // Add floating class to element
    element.classList.add('floating-video')
    element.style.position = 'fixed'
    element.style.top = `${floatingPosition.value.y}px`
    element.style.left = `${floatingPosition.value.x}px`
    element.style.width = `${videoWidth}px`
    element.style.height = `${videoHeight}px`
    element.style.zIndex = '9000'
    element.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.6)'
    element.style.borderRadius = '8px'
    element.style.overflow = 'hidden'
    element.style.transition = 'none'

    // Add close button
    addCloseButton(element)
    
    // Make draggable
    makeDraggable(element)
  }

  /**
   * Return video to original position
   */
  const returnToOriginalPosition = () => {
    if (!currentFloatingVideo.value) return

    const { element, originalParent } = currentFloatingVideo.value

    // Remove floating styles
    element.classList.remove('floating-video')
    element.style.position = ''
    element.style.top = ''
    element.style.left = ''
    element.style.width = ''
    element.style.height = ''
    element.style.zIndex = ''
    element.style.boxShadow = ''
    element.style.borderRadius = ''
    element.style.overflow = ''
    element.style.transition = ''

    // Remove close button
    const closeBtn = element.querySelector('.floating-video-close')
    if (closeBtn) closeBtn.remove()

    // Remove drag handlers
    removeDragHandlers(element)

    currentFloatingVideo.value = null
  }

  /**
   * Add close button to floating video
   */
  const addCloseButton = (element: HTMLElement) => {
    const closeBtn = document.createElement('button')
    closeBtn.className = 'floating-video-close'
    closeBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
      </svg>
    `
    closeBtn.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(0, 0, 0, 0.8);
      border: none;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 1;
      color: white;
      transition: all 0.2s ease;
    `

    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = 'rgba(237, 66, 69, 0.9)'
    })

    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = 'rgba(0, 0, 0, 0.8)'
    })

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      
      // Pause video before returning
      if (currentFloatingVideo.value?.type === 'video') {
        const video = element.querySelector('video')
        if (video) video.pause()
      } else if (currentFloatingVideo.value?.type === 'youtube') {
        const iframe = element.querySelector('iframe')
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage(
            '{"event":"command","func":"pauseVideo","args":""}',
            '*'
          )
        }
      }

      returnToOriginalPosition()
    })

    element.appendChild(closeBtn)
  }

  /**
   * Make video draggable
   */
  const makeDraggable = (element: HTMLElement) => {
    let startX = 0
    let startY = 0
    let initialX = 0
    let initialY = 0

    const onMouseDown = (e: MouseEvent) => {
      // Don't drag if clicking close button
      if ((e.target as HTMLElement).closest('.floating-video-close')) return

      isDragging.value = true
      startX = e.clientX
      startY = e.clientY
      initialX = floatingPosition.value.x
      initialY = floatingPosition.value.y

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)

      element.style.cursor = 'grabbing'
      e.preventDefault()
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.value) return

      const deltaX = e.clientX - startX
      const deltaY = e.clientY - startY

      const newX = initialX + deltaX
      const newY = initialY + deltaY

      // Constrain to viewport
      const maxX = window.innerWidth - element.offsetWidth
      const maxY = window.innerHeight - element.offsetHeight

      floatingPosition.value = {
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY))
      }

      element.style.left = `${floatingPosition.value.x}px`
      element.style.top = `${floatingPosition.value.y}px`
    }

    const onMouseUp = () => {
      isDragging.value = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      element.style.cursor = 'grab'
    }

    element.addEventListener('mousedown', onMouseDown)
    element.style.cursor = 'grab'

    // Store handlers for cleanup
    ;(element as any).__floatingDragHandlers = {
      onMouseDown
    }
  }

  /**
   * Remove drag handlers
   */
  const removeDragHandlers = (element: HTMLElement) => {
    const handlers = (element as any).__floatingDragHandlers
    if (handlers) {
      element.removeEventListener('mousedown', handlers.onMouseDown)
      element.style.cursor = ''
      delete (element as any).__floatingDragHandlers
    }
  }

  /**
   * Get current floating video
   */
  const getCurrentFloatingVideo = computed(() => currentFloatingVideo.value)

  return {
    isEnabled,
    setEnabled,
    registerVideo,
    returnToOriginalPosition,
    getCurrentFloatingVideo
  }
}

