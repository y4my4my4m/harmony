/// <reference types="vite/client" />

declare global {
  /** package.json version at build time. */
  const __APP_VERSION__: string
  /** Short git commit, '' when unavailable at build time. */
  const __APP_COMMIT__: string
  /** ISO 8601 build timestamp. */
  const __APP_BUILD_DATE__: string

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
