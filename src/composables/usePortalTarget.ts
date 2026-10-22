import { computed, inject, provide, type ComputedRef, type InjectionKey } from 'vue'

/**
 * Where a subtree's teleported popups, menus and dialogs mount. The call view
 * provides its pop-out window's container while it is popped out; everywhere
 * else the target is <body> of the main document.
 */
const PORTAL_TARGET: InjectionKey<() => HTMLElement | null> = Symbol('portal-target')

export function providePortalTarget(target: () => HTMLElement | null): void {
  provide(PORTAL_TARGET, target)
}

export function usePortalTarget(): ComputedRef<string | HTMLElement> {
  const target = inject(PORTAL_TARGET, null)
  return computed(() => target?.() ?? 'body')
}

/** The container provided above the caller, read live; null where none is (<body>). */
export function usePortalContainer(): (() => HTMLElement | null) | null {
  return inject(PORTAL_TARGET, null)
}
