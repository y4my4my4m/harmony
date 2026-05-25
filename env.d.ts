/// <reference types="vite/client" />

declare global {
  interface HTMLElement {
    /**
     * Outside-click handler installed by profile-card components that hook
     * `document` events. Stashed on the element so the matching `removeEventListener`
     * can find it when the popup closes / unmounts.
     */
    _clickOutsideHandler?: ((event: MouseEvent) => void) | null
  }
}

export {}
