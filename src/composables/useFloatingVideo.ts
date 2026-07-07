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
  sourceUrl?: string
}

// moveBefore (Chrome 133+/newer WebKit) relocates a node without resetting iframe
// or media state; insertBefore fallback reloads iframes — YouTube then restores
// playback via the seek-on-reload path in ProviderEmbedSwitch.
function moveNode(parent: HTMLElement, el: HTMLElement, before: Node | null): void {
  const mover = (parent as any).moveBefore
  if (typeof mover === 'function') {
    mover.call(parent, el, before)
  } else if (before) {
    parent.insertBefore(el, before)
  } else {
    parent.appendChild(el)
  }
}

// keep a <video> playing across a fallback (insertBefore) move
function withVideoPlaybackPreserved(element: HTMLElement, move: () => void): void {
  const video = element.querySelector('video')
  const wasPlaying = video ? !video.paused : false
  const time = video?.currentTime ?? 0
  move()
  if (video && wasPlaying && video.paused) {
    video.currentTime = time
    void video.play().catch(() => {})
  }
}

// Global state (singleton)
const currentFloatingVideo = ref<VideoElement | null>(null)
const floatingPosition = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const isUserSetting = ref(true) // Default: enabled

// After a manual dock the observer must not immediately re-float the video
// (the returned embed can sit <20% visible at a viewport edge — feedback loop)
let lastReturnAt = 0
const REFLOAT_COOLDOWN_MS = 800

// Per-element bookkeeping. WeakMaps keyed by the video element so entries
// vanish with the element instead of living as ad-hoc expando properties.
const videoObservers = new WeakMap<HTMLElement, IntersectionObserver>()
const dragState = new WeakMap<HTMLElement, { onMouseDown: (e: MouseEvent) => void }>()
const resizeHandleState = new WeakMap<HTMLElement, HTMLElement[]>()

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
    type: 'youtube' | 'video',
    sourceUrl?: string
  ): (() => void) => {
    if (!isEnabled.value) return () => {}

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Skip if this video is already floating (prevents feedback loop)
          if (currentFloatingVideo.value?.messageId === messageId && currentFloatingVideo.value?.element === element) {
            return
          }

          const isPlaying = checkIfPlaying(element, type)

          // If video is playing and less than 20% visible, float it
          if (
            isPlaying &&
            entry.intersectionRatio < 0.2 &&
            !currentFloatingVideo.value &&
            Date.now() - lastReturnAt > REFLOAT_COOLDOWN_MS
          ) {
            floatVideo(element, originalParent, messageId, type, sourceUrl)
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
      // YouTube play state comes via the postMessage API
      // This requires the iframe to have enablejsapi=1
      const iframe = element.querySelector('iframe')
      if (!iframe) return false
      
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
    type: 'youtube' | 'video',
    sourceUrl?: string
  ) => {
    // If another video is already floating, return it first
    if (currentFloatingVideo.value && currentFloatingVideo.value.messageId !== messageId) {
      returnToOriginalPosition()
    }

    // Temporarily disconnect observer to prevent feedback loop
    videoObservers.get(element)?.disconnect()

    const videoEl = element.querySelector('video') || element.querySelector('iframe')
    let aspectRatio = 16 / 9 // Default fallback

    if (videoEl) {
      const rect = videoEl.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        aspectRatio = rect.width / rect.height
      }
    }

    // skeleton keeps the embed's exact footprint so the message layout doesn't shift
    const elementRect = element.getBoundingClientRect()
    const placeholder = document.createElement('button')
    placeholder.type = 'button'
    placeholder.className = 'floating-video-placeholder'
    placeholder.title = 'Bring the video back here'
    placeholder.style.width = `${Math.round(elementRect.width)}px`
    placeholder.style.height = `${Math.round(elementRect.height)}px`
    placeholder.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="2"/>
        <rect x="11" y="11" width="8" height="6" rx="1" fill="currentColor"/>
      </svg>
      <span class="floating-video-placeholder__label">Playing in floating player</span>
      <span class="floating-video-placeholder__hint">Click to bring back</span>
    `
    placeholder.addEventListener('click', (e) => {
      e.stopPropagation()
      returnToOriginalPosition({ scrollIntoView: true })
    })

    element.parentNode?.insertBefore(placeholder, element)

    currentFloatingVideo.value = {
      element,
      originalParent,
      messageId,
      type,
      isPlaying: true,
      placeholder,
      aspectRatio,
      sourceUrl
    }

    const windowWidth = window.innerWidth
    const videoWidth = Math.min(400, windowWidth * 0.9)
    const videoHeight = videoWidth / aspectRatio

    floatingPosition.value = {
      x: windowWidth - videoWidth - 20,
      y: 80
    }

    // Move element out of the virtual scroller to document.body so it
    // survives row unmounting by the virtualizer
    withVideoPlaybackPreserved(element, () => moveNode(document.body, element, null))

    element.classList.add('floating-video')
    element.style.position = 'fixed'
    element.style.top = `${floatingPosition.value.y}px`
    element.style.left = `${floatingPosition.value.x}px`
    element.style.width = `${videoWidth}px`
    element.style.height = `${videoHeight}px`
    element.style.zIndex = '9000'
    element.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.6)'
    element.style.borderRadius = '8px'
    // no overflow:hidden — it would clip the resize handles sitting outside the corners
    element.style.transition = 'none'
    element.style.maxWidth = 'none'
    element.style.maxHeight = 'none'
    element.style.minWidth = '200px'
    element.style.minHeight = `${200 / aspectRatio}px`

    if (videoEl) {
      (videoEl as HTMLElement).style.width = '100%';
      (videoEl as HTMLElement).style.height = '100%';
      (videoEl as HTMLElement).style.objectFit = 'contain';
      (videoEl as HTMLElement).style.maxWidth = 'none';
      (videoEl as HTMLElement).style.maxHeight = 'none';
      (videoEl as HTMLElement).style.borderRadius = '8px';
    }
    
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

    buildChrome(element, sourceUrl)

    makeDraggable(element)

    makeResizable(element)
  }

  /**
   * Return video to original position
   */
  const returnToOriginalPosition = (options: { scrollIntoView?: boolean } = {}) => {
    if (!currentFloatingVideo.value) return

    // Vue's ref unwrapping types HTMLElement props as a complex unwrapped shape;
    // cast back to HTMLElement so DOM APIs accept these values.
    const { element, placeholder } = currentFloatingVideo.value as unknown as VideoElement

    // Playback intentionally continues across the return (Discord-style);
    // pausing is the close button's job, not the docking move's.
    if (placeholder && placeholder.parentNode) {
      withVideoPlaybackPreserved(element, () =>
        moveNode(placeholder.parentNode as HTMLElement, element, placeholder)
      )
      placeholder.parentNode.removeChild(placeholder)
    }

    const videoEl = element.querySelector('video') || element.querySelector('iframe')
    if (videoEl) {
      (videoEl as HTMLElement).style.width = '';
      (videoEl as HTMLElement).style.height = '';
      (videoEl as HTMLElement).style.objectFit = '';
      (videoEl as HTMLElement).style.maxWidth = '';
      (videoEl as HTMLElement).style.maxHeight = '';
      (videoEl as HTMLElement).style.borderRadius = '';
    }
    
    const overlay = element.querySelector('.floating-video-interaction-overlay')
    if (overlay) overlay.remove()

    element.querySelector('.floating-video-chrome')?.remove()

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

    removeResizeHandles(element)

    removeDragHandlers(element)

    currentFloatingVideo.value = null
    lastReturnAt = Date.now()

    if (options.scrollIntoView) {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    // Reconnect after the cooldown so the initial observation (or the scroll
    // animation) can't immediately re-float the video we just docked
    setTimeout(() => {
      if (currentFloatingVideo.value?.element !== element && element.isConnected) {
        videoObservers.get(element)?.observe(element)
      }
    }, REFLOAT_COOLDOWN_MS)
  }

  /**
   * Hover chrome: one top bar with drag space + open / dock / close actions
   */
  const buildChrome = (element: HTMLElement, sourceUrl?: string) => {
    const bar = document.createElement('div')
    bar.className = 'floating-video-chrome'

    const grip = document.createElement('span')
    grip.className = 'floating-video-chrome__grip'
    grip.textContent = 'Floating player'
    bar.appendChild(grip)

    const makeButton = (label: string, svg: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'floating-video-chrome__btn'
      btn.title = label
      btn.setAttribute('aria-label', label)
      btn.innerHTML = svg
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick()
      })
      bar.appendChild(btn)
      return btn
    }

    if (sourceUrl) {
      makeButton(
        'Open link',
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        () => window.open(sourceUrl, '_blank', 'noopener,noreferrer')
      )
    }

    // Native browser PiP — only possible for <video>; cross-origin iframes
    // (YouTube) can't be sent to PiP programmatically
    const pipVideo = currentFloatingVideo.value?.type === 'video' ? element.querySelector('video') : null
    if (pipVideo && document.pictureInPictureEnabled && !pipVideo.disablePictureInPicture) {
      makeButton(
        'Picture-in-picture',
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none"/></svg>',
        () => {
          void pipVideo.requestPictureInPicture()
            .then(() => returnToOriginalPosition())
            .catch(() => {})
        }
      )
    }

    makeButton(
      'Back to chat',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M15 14l-5-4v3H6v2h4v3z" fill="currentColor" stroke="none"/></svg>',
      () => returnToOriginalPosition({ scrollIntoView: true })
    )

    const closeBtn = makeButton(
      'Close and pause',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
      () => {
        // Close means stop watching: pause, then dock
        if (currentFloatingVideo.value?.type === 'video') {
          element.querySelector('video')?.pause()
        } else if (currentFloatingVideo.value?.type === 'youtube') {
          const iframe = element.querySelector('iframe')
          iframe?.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*')
          // the docking move may reload the iframe before the pause lands; the
          // dataset flag keeps the seek-restore path from resuming playback
          element.dataset.isPlaying = 'false'
        }
        returnToOriginalPosition()
      }
    )
    closeBtn.classList.add('floating-video-chrome__btn--close')

    element.appendChild(bar)
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

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement

      // Don't drag from action buttons or resize handles
      if (target.closest('.floating-video-chrome__btn') || target.closest('.resize-handle')) {
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
    }

    element.addEventListener('mousedown', onMouseDown)

    dragState.set(element, { onMouseDown })
  }

  /**
   * Remove drag handlers
   */
  const removeDragHandlers = (element: HTMLElement) => {
    const handlers = dragState.get(element)
    if (handlers) {
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

    // visibility is CSS-driven (.floating-video:hover .resize-handle) — JS hover
    // listeners here leaked because they were re-added on every float
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

      element.style.width = `${newWidth}px`;
      element.style.height = `${newHeight}px`;
      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
      element.style.minHeight = `${200 / aspectRatio}px`;

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

