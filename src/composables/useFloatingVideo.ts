/**
 * Floating Video Player Composable
 * Manages floating video state for YouTube and native video elements
 */

import { ref, computed } from 'vue'

interface VideoElement {
  element: HTMLElement
  originalParent: HTMLElement
  messageId: string
  type: 'youtube' | 'video'
  isPlaying: boolean
  placeholder?: HTMLElement
  aspectRatio: number
}

// Global state (singleton)
const currentFloatingVideo = ref<VideoElement | null>(null)
const floatingPosition = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const isUserSetting = ref(true) // Default: enabled

// Per-element bookkeeping. WeakMaps keyed by the video element so entries
// vanish with the element instead of living as ad-hoc expando properties.
const videoObservers = new WeakMap<HTMLElement, IntersectionObserver>()
const dragState = new WeakMap<HTMLElement, { dragHandle: HTMLElement; onMouseDown: (e: MouseEvent) => void }>()
const resizeHandleState = new WeakMap<HTMLElement, HTMLElement[]>()

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
  ): (() => void) => {
    if (!isEnabled.value) return () => {}

    // Setup intersection observer to detect when video leaves viewport
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Skip if this video is already floating (prevents feedback loop)
          if (currentFloatingVideo.value?.messageId === messageId && currentFloatingVideo.value?.element === element) {
            return
          }
          
          const isPlaying = checkIfPlaying(element, type)
          
          // If video is playing and less than 20% visible, float it
          if (isPlaying && entry.intersectionRatio < 0.2 && !currentFloatingVideo.value) {
            floatVideo(element, originalParent, messageId, type)
          }
          // If video is back in view and is floating, return it
          else if (entry.intersectionRatio > 0.8 && currentFloatingVideo.value?.messageId === messageId) {
            returnToOriginalPosition()
          }
        })
      },
      {
        root: null, // Use viewport as root
        rootMargin: '0px',
        threshold: [0, 0.2, 0.8, 1.0]
      }
    )

    // Re-registration (e.g. content re-render) must not stack observers.
    videoObservers.get(element)?.disconnect()

    observer.observe(element)
    videoObservers.set(element, observer)

    // registerVideo is called from async callbacks (nextTick after mount),
    // where onUnmounted() has no component instance and silently no-ops -
    // that leaked one observer per rendered video (BUGS.md H43). The caller
    // owns the lifecycle: invoke the returned cleanup in its own unmount hook.
    return () => {
      observer.disconnect()
      if (videoObservers.get(element) === observer) {
        videoObservers.delete(element)
      }
    }
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

    // Temporarily disconnect observer to prevent feedback loop
    videoObservers.get(element)?.disconnect()

    // Get the actual video/iframe element to determine aspect ratio
    const videoEl = element.querySelector('video') || element.querySelector('iframe')
    let aspectRatio = 16 / 9 // Default fallback
    
    if (videoEl) {
      const rect = videoEl.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        aspectRatio = rect.width / rect.height
      }
    }

    // Create placeholder skeleton
    const placeholder = document.createElement('div')
    const elementRect = element.getBoundingClientRect()
    placeholder.className = 'floating-video-placeholder'
    placeholder.style.cssText = `
      width: 100%;
      height: ${elementRect.height}px;
      border-radius: 8px;
      background: linear-gradient(
        90deg,
        #40444b 0%,
        #484c52 50%,
        #40444b 100%
      );
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s infinite;
      position: relative;
    `
    
    // Add a "Video is floating" message to the placeholder
    const message = document.createElement('div')
    message.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: var(--text-secondary);
      font-size: 14px;
      text-align: center;
      pointer-events: none;
    `
    message.textContent = '📹 Video is floating'
    placeholder.appendChild(message)
    
    // Insert placeholder where the element currently is
    element.parentNode?.insertBefore(placeholder, element)

    currentFloatingVideo.value = {
      element,
      originalParent,
      messageId,
      type,
      isPlaying: true,
      placeholder,
      aspectRatio
    }

    // Calculate initial position (top-right corner)
    const windowWidth = window.innerWidth
    const videoWidth = Math.min(400, windowWidth * 0.9)
    const videoHeight = videoWidth / aspectRatio
    
    floatingPosition.value = {
      x: windowWidth - videoWidth - 20,
      y: 80
    }

    // Move element out of the virtual scroller to document.body so it
    // survives row unmounting by the virtualizer
    document.body.appendChild(element)

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
    element.style.maxWidth = 'none'
    element.style.maxHeight = 'none'
    element.style.minWidth = '200px'
    element.style.minHeight = `${200 / aspectRatio}px`

    // Make video/iframe fill the container but not intercept mouse events on edges
    if (videoEl) {
      (videoEl as HTMLElement).style.width = '100%';
      (videoEl as HTMLElement).style.height = '100%';
      (videoEl as HTMLElement).style.objectFit = 'contain';
      (videoEl as HTMLElement).style.maxWidth = 'none';
      (videoEl as HTMLElement).style.maxHeight = 'none';
    }
    
    // Add a transparent overlay for drag/resize interactions
    const interactionOverlay = document.createElement('div')
    interactionOverlay.className = 'floating-video-interaction-overlay'
    interactionOverlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 5;
    `
    element.appendChild(interactionOverlay)
    
    // Add close button
    addCloseButton(element)
    
    // Make draggable
    makeDraggable(element)
    
    // Make resizable
    makeResizable(element)
  }

  /**
   * Return video to original position
   */
  const returnToOriginalPosition = () => {
    if (!currentFloatingVideo.value) return

    // Vue's ref unwrapping types HTMLElement props as a complex unwrapped shape;
    // cast back to HTMLElement so DOM APIs accept these values.
    const { element, placeholder, type } = currentFloatingVideo.value as unknown as VideoElement

    // Pause the video before returning
    if (type === 'video') {
      const video = element.querySelector('video')
      if (video) video.pause()
    } else if (type === 'youtube') {
      const iframe = element.querySelector('iframe')
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          '{"event":"command","func":"pauseVideo","args":""}',
          '*'
        )
      }
    }

    // Move element back to its original position (before placeholder) since
    // it was reparented to document.body when floating started
    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(element, placeholder)
      placeholder.parentNode.removeChild(placeholder)
    }

    // Reset video/iframe styles
    const videoEl = element.querySelector('video') || element.querySelector('iframe')
    if (videoEl) {
      (videoEl as HTMLElement).style.width = '';
      (videoEl as HTMLElement).style.height = '';
      (videoEl as HTMLElement).style.objectFit = '';
      (videoEl as HTMLElement).style.maxWidth = '';
      (videoEl as HTMLElement).style.maxHeight = '';
    }
    
    // Remove interaction overlay
    const overlay = element.querySelector('.floating-video-interaction-overlay')
    if (overlay) overlay.remove()
    
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
    element.style.maxWidth = ''
    element.style.maxHeight = ''
    element.style.minWidth = ''
    element.style.minHeight = ''

    // Remove close button
    const closeBtn = element.querySelector('.floating-video-close')
    if (closeBtn) closeBtn.remove()

    // Remove resize handles
    removeResizeHandles(element)

    // Remove drag handlers
    removeDragHandlers(element)

    // Reconnect observer to continue watching for scroll events
    videoObservers.get(element)?.observe(element)

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
      z-index: 10;
      color: white;
      transition: all 0.2s ease;
      pointer-events: all;
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
    // eslint-disable-next-line unused-imports/no-unused-vars
    let hasMoved = false

    // Create a drag handle bar across the entire top
    const dragHandle = document.createElement('div')
    dragHandle.className = 'floating-video-drag-handle'
    dragHandle.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 50px;
      height: 45px;
      background: linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 70%, transparent 100%);
      cursor: move;
      z-index: 15;
      display: flex;
      align-items: center;
      padding-left: 12px;
      color: white;
      font-size: 11px;
      font-weight: 600;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: all;
      user-select: none;
    `
    dragHandle.innerHTML = '<span style="opacity: 0.8;">⋮⋮ Drag to move</span>'
    element.appendChild(dragHandle)
    
    // Show handle on hover
    element.addEventListener('mouseenter', () => {
      dragHandle.style.opacity = '1'
    })
    
    element.addEventListener('mouseleave', () => {
      if (!isDragging.value) {
        dragHandle.style.opacity = '0'
      }
    })

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      
      // Don't drag if clicking close button or resize handles
      if (target.closest('.floating-video-close') || target.closest('.resize-handle')) {
        return
      }

      isDragging.value = false
      hasMoved = false
      startX = e.clientX
      startY = e.clientY
      initialX = floatingPosition.value.x
      initialY = floatingPosition.value.y

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)

      element.style.cursor = 'grabbing'
      e.preventDefault()
      e.stopPropagation()
    }

    const onMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startX
      const deltaY = e.clientY - startY
      
      // Consider it a drag if moved more than 3 pixels
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        isDragging.value = true
        hasMoved = true
      }

      if (!isDragging.value) return

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

    const onMouseUp = (_e: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      
      isDragging.value = false
      element.style.cursor = ''
      dragHandle.style.opacity = '0'
    }

    // Make entire element draggable
    element.addEventListener('mousedown', onMouseDown)
    dragHandle.addEventListener('mousedown', onMouseDown)

    dragState.set(element, { dragHandle, onMouseDown })
  }

  /**
   * Remove drag handlers
   */
  const removeDragHandlers = (element: HTMLElement) => {
    const handlers = dragState.get(element)
    if (handlers) {
      handlers.dragHandle.remove()
      element.removeEventListener('mousedown', handlers.onMouseDown)
      element.style.cursor = ''
      dragState.delete(element)
    }
  }

  /**
   * Make video resizable
   */
  const makeResizable = (element: HTMLElement) => {
    const resizeHandles: { position: string; cursor: string }[] = [
      { position: 'top-left', cursor: 'nwse-resize' },
      { position: 'top-right', cursor: 'nesw-resize' },
      { position: 'bottom-left', cursor: 'nesw-resize' },
      { position: 'bottom-right', cursor: 'nwse-resize' },
    ]

    const handles: HTMLElement[] = []

    resizeHandles.forEach(({ position, cursor }) => {
      const handle = document.createElement('div')
      handle.className = `resize-handle resize-${position}`
      handle.style.cssText = `
        position: absolute;
        width: 12px;
        height: 12px;
        background: rgba(14, 165, 233, 0.8);
        border: 2px solid white;
        border-radius: 50%;
        cursor: ${cursor};
        z-index: 10;
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: all;
      `

      // Position the handle
      if (position.includes('top')) handle.style.top = '-6px'
      if (position.includes('bottom')) handle.style.bottom = '-6px'
      if (position.includes('left')) handle.style.left = '-6px'
      if (position.includes('right')) handle.style.right = '-6px'

      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation()
        e.preventDefault()
        startResize(e, element, position)
      })

      element.appendChild(handle)
      handles.push(handle)
    })

    // Show handles on hover
    element.addEventListener('mouseenter', () => {
      handles.forEach(h => h.style.opacity = '1')
    })

    element.addEventListener('mouseleave', () => {
      handles.forEach(h => h.style.opacity = '0')
    })

    resizeHandleState.set(element, handles)
  }

  /**
   * Start resizing video
   */
  const startResize = (e: MouseEvent, element: HTMLElement, position: string) => {
    if (!currentFloatingVideo.value) return
    
    const startX = e.clientX
    const startY = e.clientY
    const startWidth = element.offsetWidth
    const startHeight = element.offsetHeight
    const startLeft = parseFloat(element.style.left)
    const startTop = parseFloat(element.style.top)
    const aspectRatio = currentFloatingVideo.value.aspectRatio

    const onMouseMove = (e: MouseEvent) => {
      const currentX = e.clientX
      const currentY = e.clientY
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      
      let newWidth = startWidth
      let newHeight = startHeight
      let newLeft = startLeft
      let newTop = startTop

      // Determine primary resize direction based on which delta is larger
      const isHorizontalPrimary = Math.abs(deltaX) > Math.abs(deltaY)

      if (isHorizontalPrimary) {
        // Resize based on width, calculate height from aspect ratio
        if (position.includes('right')) {
          newWidth = startWidth + deltaX
        } else if (position.includes('left')) {
          newWidth = startWidth - deltaX
          newLeft = startLeft + deltaX
        }
        
        // Constrain width
        newWidth = Math.max(200, Math.min(1200, newWidth))
        
        // Calculate height from width to maintain aspect ratio
        newHeight = newWidth / aspectRatio
        
        // Adjust position for top corners
        if (position.includes('top')) {
          newTop = startTop + startHeight - newHeight
        }
      } else {
        // Resize based on height, calculate width from aspect ratio
        if (position.includes('bottom')) {
          newHeight = startHeight + deltaY
        } else if (position.includes('top')) {
          newHeight = startHeight - deltaY
          newTop = startTop + deltaY
        }
        
        // Calculate width from height to maintain aspect ratio
        newWidth = newHeight * aspectRatio
        
        // Constrain width
        newWidth = Math.max(200, Math.min(1200, newWidth))
        newHeight = newWidth / aspectRatio
        
        // Recalculate position
        if (position.includes('top')) {
          newTop = startTop + startHeight - newHeight
        }
        if (position.includes('left')) {
          newLeft = startLeft + startWidth - newWidth
        }
      }

      // Final position adjustment for left corners
      if (position.includes('left')) {
        newLeft = startLeft + startWidth - newWidth
      }

      // Constrain to viewport
      const maxX = window.innerWidth - newWidth
      const maxY = window.innerHeight - newHeight
      newLeft = Math.max(0, Math.min(newLeft, maxX))
      newTop = Math.max(0, Math.min(newTop, maxY))

      // Apply new dimensions
      element.style.width = `${newWidth}px`;
      element.style.height = `${newHeight}px`;
      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
      element.style.minHeight = `${200 / aspectRatio}px`;

      // Update floating position
      floatingPosition.value = { x: newLeft, y: newTop }
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  /**
   * Remove resize handles
   */
  const removeResizeHandles = (element: HTMLElement) => {
    const handles = resizeHandleState.get(element)
    if (handles) {
      handles.forEach(handle => handle.remove())
      resizeHandleState.delete(element)
    }
  }

  /**
   * Get current floating video
   */
  const getCurrentFloatingVideo = computed(() => currentFloatingVideo.value)

  /**
   * Check if a video is currently floating
   */
  const hasFloatingVideo = computed(() => currentFloatingVideo.value !== null)

  /**
   * Get the messageId of the currently floating video
   */
  const getFloatingVideoMessageId = () => {
    return currentFloatingVideo.value?.messageId || null
  }

  return {
    isEnabled,
    setEnabled,
    registerVideo,
    returnToOriginalPosition,
    getCurrentFloatingVideo,
    hasFloatingVideo,
    getFloatingVideoMessageId
  }
}

