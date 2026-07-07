// Shared reactive viewport state: one resize listener for the whole app
// instead of per-component window.innerWidth reads (which are non-reactive
// inside computeds) and duplicated resize handlers.

import { ref } from 'vue'

const MOBILE_BREAKPOINT = 768

const hasWindow = typeof window !== 'undefined'

const viewportWidth = ref(hasWindow ? window.innerWidth : 1024)
const viewportHeight = ref(hasWindow ? window.innerHeight : 768)
const isMobileViewport = ref(hasWindow ? window.innerWidth <= MOBILE_BREAKPOINT : false)

// Coarse-pointer-only device (phones/tablets); touch laptops keep 'pointer: fine'.
const isTouchOnly = hasWindow
  ? 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches
  : false

if (hasWindow) {
  window.addEventListener(
    'resize',
    () => {
      viewportWidth.value = window.innerWidth
      viewportHeight.value = window.innerHeight
      isMobileViewport.value = window.innerWidth <= MOBILE_BREAKPOINT
    },
    { passive: true }
  )
}

export function useViewport() {
  return {
    viewportWidth,
    viewportHeight,
    isMobileViewport,
    isTouchOnly,
    MOBILE_BREAKPOINT,
  }
}
