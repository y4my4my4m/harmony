/**
 * Off-canvas drawer semantics for panels that slide in and out (mobile
 * navigation, member list). Visual state stays with the component's CSS.
 *
 *   const { toggleAttrs } = useDrawer({
 *     open: leftSidebarOpen,
 *     elements: () => [railEl.value, channelsEl.value],
 *     collapsible: () => isMobile.value,
 *     modal: () => isMobile.value,
 *     keep: () => [backdropEl.value],
 *     onClose: closeMobileSidebars,
 *     ids: ['app-server-rail', 'app-channel-panel'],
 *   })
 *   <button v-bind="toggleAttrs" @click="toggle">
 *
 * While `collapsible` and closed, every element is inert and aria-hidden: an
 * offscreen or zero-width panel is neither tabbable nor read. Not collapsible
 * (a desktop column) means no attributes at all.
 *
 * While open and `modal`, everything outside `elements` and `keep` is inert,
 * Escape (topmost layer only) calls onClose, focus moves into the drawer (its
 * [aria-current] item, else its first tabbable, else the first element), and on
 * close focus returns to the element that was focused when it opened.
 *
 * `toggleAttrs`: aria-expanded and aria-controls (the given ids) for every
 * button that opens or closes this drawer.
 *
 * useAppDrawers() in useLayoutState.ts holds the app's two drawers' ids and
 * toggle attributes for headers that render a hamburger or members button.
 */

import { computed, onBeforeUnmount, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { currentFocusOrigin, focusElement, focusProgrammatically, isVisibleForFocus, tabbables, trackLastFocused } from '@/utils/a11y/focus'
import { holdInert, inertOthers, pushLayer, resolveFocusOrigin } from '@/utils/a11y/layers'

export interface UseDrawerOptions {
  open: MaybeRefOrGetter<boolean>
  elements: () => Array<HTMLElement | null | undefined>
  /** The panel hides when closed. Default true. */
  collapsible?: MaybeRefOrGetter<boolean>
  /** An open drawer covers the page (mobile). Default false. */
  modal?: MaybeRefOrGetter<boolean>
  /** Elements that stay interactive while modal, e.g. the backdrop. */
  keep?: () => Array<Element | null | undefined>
  onClose: () => void
  /** Ids of the drawer elements, for aria-controls. */
  ids?: MaybeRefOrGetter<string[]>
  /** False: opening does not move focus (a drag gesture). Default true. */
  moveFocus?: MaybeRefOrGetter<boolean>
}

function present<T>(list: Array<T | null | undefined>): T[] {
  return list.filter((x): x is T => !!x)
}

export function useDrawer(options: UseDrawerOptions) {
  trackLastFocused()

  let hiddenRelease: Array<() => void> = []
  let hiddenEls: HTMLElement[] = []
  let modalCleanups: Array<() => void> = []
  let opener: HTMLElement | null = null
  let modalEls: HTMLElement[] = []

  const releaseHidden = () => {
    hiddenRelease.forEach((fn) => fn())
    hiddenRelease = []
    hiddenEls.forEach((el) => el.removeAttribute('aria-hidden'))
    hiddenEls = []
  }

  const applyHidden = (els: HTMLElement[]) => {
    releaseHidden()
    for (const el of els) {
      hiddenRelease.push(holdInert(el))
      el.setAttribute('aria-hidden', 'true')
      hiddenEls.push(el)
    }
  }

  const focusInto = (els: HTMLElement[]) => {
    for (const el of els) {
      const current = el.querySelector<HTMLElement>('[aria-current]:not([aria-current="false"])')
      if (current && isVisibleForFocus(current) && focusElement(current)) return
    }
    for (const el of els) {
      const first = tabbables(el)[0]
      if (first && focusElement(first)) return
    }
    focusProgrammatically(els[0])
  }

  const endModal = (restore: boolean) => {
    const els = modalEls
    modalCleanups.forEach((fn) => fn())
    modalCleanups = []
    modalEls = []
    if (!restore) return
    const focus = document.activeElement
    const lost = !focus || focus === document.body || els.some((el) => el.contains(focus))
    if (lost && opener?.isConnected && isVisibleForFocus(opener)) focusElement(opener)
  }

  const startModal = (els: HTMLElement[]) => {
    modalEls = els
    const keep = present(options.keep?.() ?? [])
    modalCleanups.push(inertOthers([...els, ...keep]))
    modalCleanups.push(pushLayer({ kind: 'drawer', element: () => els[0], onEscape: options.onClose }))
    // The Escape stack checks focus against one element; a drawer of several
    // panels routes Escape from any of them.
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (els.slice(1).some((el) => el.contains(event.target as Node))) {
        event.preventDefault()
        options.onClose()
      }
    }
    els.slice(1).forEach((el) => el.addEventListener('keydown', onKeydown))
    modalCleanups.push(() => els.slice(1).forEach((el) => el.removeEventListener('keydown', onKeydown)))
    if (toValue(options.moveFocus) !== false && !els.some((el) => el.contains(document.activeElement))) focusInto(els)
  }

  watch(
    () => toValue(options.open),
    (open, wasOpen) => {
      if (open && !wasOpen) opener = resolveFocusOrigin(currentFocusOrigin())
    },
    { flush: 'sync', immediate: true },
  )

  watch(
    () => [toValue(options.open), toValue(options.collapsible) !== false, !!toValue(options.modal), ...options.elements()] as const,
    () => {
      const els = present(options.elements())
      const open = toValue(options.open)
      const collapsible = toValue(options.collapsible) !== false
      const modal = !!toValue(options.modal)

      if (collapsible && !open) {
        if (modalEls.length) endModal(true)
        applyHidden(els)
        return
      }
      releaseHidden()
      const wantModal = collapsible && open && modal && els.length > 0
      const sameEls = modalEls.length === els.length && modalEls.every((el, i) => el === els[i])
      if (modalEls.length && (!wantModal || !sameEls)) endModal(!wantModal)
      if (wantModal && !modalEls.length) startModal(els)
    },
    { flush: 'post', immediate: true },
  )

  onBeforeUnmount(() => {
    releaseHidden()
    if (modalEls.length) endModal(false)
  })

  const toggleAttrs = computed(() => {
    const ids = toValue(options.ids) ?? []
    return {
      'aria-expanded': toValue(options.open) ? ('true' as const) : ('false' as const),
      'aria-controls': ids.length ? ids.join(' ') : undefined,
    }
  })

  return { toggleAttrs }
}
