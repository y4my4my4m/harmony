// Shared reactive viewport state: one resize listener for the whole app
// instead of per-component window.innerWidth reads (which are non-reactive
// inside computeds) and duplicated resize handlers.

import { ref, watch } from 'vue'
import { cssZoomFactor } from '@/utils/appZoom'

const MOBILE_BREAKPOINT = 768

const hasWindow = typeof window !== 'undefined'

// Width and height are CSS pixels: under CSS zoom (src/utils/appZoom.ts) innerWidth is
// viewport pixels and a length derived from it is zoomed again. isMobileViewport follows
// the viewport pixels media queries evaluate.
const viewportWidth = ref(hasWindow ? window.innerWidth : 1024)
const viewportHeight = ref(hasWindow ? window.innerHeight : 768)
const isMobileViewport = ref(hasWindow ? window.innerWidth <= MOBILE_BREAKPOINT : false)

function measure() {
  viewportWidth.value = window.innerWidth / cssZoomFactor.value
  viewportHeight.value = window.innerHeight / cssZoomFactor.value
  isMobileViewport.value = window.innerWidth <= MOBILE_BREAKPOINT
}

// Coarse-pointer-only device (phones/tablets); touch laptops keep 'pointer: fine'.
const isTouchOnly = hasWindow
  ? 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches
  : false

if (hasWindow) {
  window.addEventListener('resize', measure, { passive: true })
  watch(cssZoomFactor, measure)
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
