/**
 * Route changes for screen-reader and keyboard users. Installed once, in App.vue.
 *
 * - document.title follows the view: route meta.titleKey (translated), or a
 *   view's useViewTitle() override, composed by utils/a11y/documentTitle.ts with
 *   the unread prefix and the instance name.
 * - After a navigation (not the first load), the new view title is announced
 *   politely once it is known (a channel name arrives with its store), at the
 *   latest after ANNOUNCE_FALLBACK_MS.
 * - Focus is repaired, never stolen: when the navigation left focus on <body>
 *   (the focused element unmounted with the old view), it moves to the view's
 *   first heading in <main>, else to <main> itself. Focus that survived the
 *   navigation (the composer focused on a channel switch, a sidebar link) stays.
 *
 * Views with a dynamic title:
 *   useViewTitle(() => channel.value ? `#${channel.value.name} – ${server.value?.name}` : '')
 */

import { getCurrentInstance, onBeforeUnmount, watch } from 'vue'
import type { Router } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { announce } from '@/composables/useAnnouncer'
import { focusProgrammatically, isVisibleForFocus } from '@/utils/a11y/focus'
import { composedTitle, pushViewTitle, setRouteTitle, viewTitle } from '@/utils/a11y/documentTitle'

/** Wait for the new view's setup to register its title before announcing, ms. */
export const SETTLE_MS = 250
/** Latest wait for a dynamic view title before announcing what is there, ms. */
export const ANNOUNCE_FALLBACK_MS = 1500
/** Delay before checking for lost focus; async route components mount within it, ms. */
export const FOCUS_REPAIR_MS = 400

export const MAIN_CONTENT_ID = 'main-content'

/** Moves focus into the main landmark when it sits on <body>. */
export function repairLostFocus(): boolean {
  const active = document.activeElement
  if (active && active !== document.body && active !== document.documentElement) return false
  const main = document.getElementById(MAIN_CONTENT_ID) ?? document.querySelector<HTMLElement>('main, [role="main"]')
  if (!main || !isVisibleForFocus(main)) return false
  const heading = Array.from(main.querySelectorAll<HTMLElement>('h1, h2')).find(isVisibleForFocus)
  return focusProgrammatically(heading ?? main)
}

/** Dynamic view title for the calling component's lifetime. */
export function useViewTitle(get: () => string): void {
  const remove = pushViewTitle(get)
  if (getCurrentInstance()) onBeforeUnmount(remove)
}

export function useRouteA11y(router: Router): void {
  const { t, locale } = useI18n()
  let currentKey = ''
  let repairTimer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  let settled = false
  let titleBefore = ''
  const timers: Array<ReturnType<typeof setTimeout>> = []

  const clearTimers = () => {
    timers.forEach(clearTimeout)
    timers.length = 0
  }

  const flush = () => {
    if (!pending) return
    pending = false
    clearTimers()
    if (viewTitle.value) announce(viewTitle.value, { key: 'route', dedupeMs: 0 })
  }

  const removeHook = router.afterEach((to, from, failure) => {
    if (failure) return
    titleBefore = viewTitle.value
    currentKey = typeof to.meta?.titleKey === 'string' ? to.meta.titleKey : ''
    setRouteTitle(currentKey ? t(currentKey) : '')
    // First load: the screen reader reads the page title itself. Query-only
    // changes (a jump to a message) are not a new view.
    if (!from.matched.length || to.path === from.path) return
    clearTimers()
    pending = true
    settled = false
    timers.push(
      setTimeout(() => {
        settled = true
        if (viewTitle.value && viewTitle.value !== titleBefore) flush()
      }, SETTLE_MS),
      setTimeout(flush, ANNOUNCE_FALLBACK_MS),
    )
    if (repairTimer) clearTimeout(repairTimer)
    repairTimer = setTimeout(() => {
      repairTimer = null
      repairLostFocus()
    }, FOCUS_REPAIR_MS)
  })

  watch(locale, () => setRouteTitle(currentKey ? t(currentKey) : ''))

  watch(viewTitle, (title) => {
    if (pending && settled && title && title !== titleBefore) flush()
  })

  watch(composedTitle, (title) => {
    if (typeof document !== 'undefined') document.title = title
  }, { immediate: true })

  onBeforeUnmount(() => {
    removeHook()
    clearTimers()
    if (repairTimer) clearTimeout(repairTimer)
  })
}
