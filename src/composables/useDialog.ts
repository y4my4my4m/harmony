/**
 * Modal dialog behaviour for an element that carries role="dialog" or
 * role="alertdialog". The component renders the role and labelling; this
 * composable owns focus and the background.
 *
 *   const el = ref<HTMLElement | null>(null)
 *   const { titleId, descriptionId } = useDialog({
 *     open: () => props.show,
 *     element: el,
 *     onClose: () => emit('close'),
 *   })
 *
 *   <div ref="el" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
 *     <h2 :id="titleId">...</h2>
 *
 * While open and mounted:
 * - focus moves in: options.initialFocus, else [data-autofocus]/[autofocus],
 *   else the first text field, else the dialog element itself (which reads
 *   its label);
 * - Tab and Shift+Tab wrap inside the dialog;
 * - Escape reaches only the topmost layer (utils/a11y/layers.ts) and calls
 *   onClose unless closeOnEscape is false, in which case it is swallowed;
 * - everything outside is inert and <body> does not scroll;
 * - on close, focus returns to the element focused at opening. An opener
 *   inside a menu resolves to the menu's trigger; an opener that has
 *   unmounted falls back to the opener of the dialog it sat in, then to
 *   options.returnFocus.
 *
 * A dialog rendered with v-if passes `open: () => true`; the opener is read
 * at setup, before the dialog's DOM exists.
 *
 * AppDialog.vue wraps this with a Teleport and an overlay. BaseModal and
 * UnifiedModal use it directly.
 */

import { onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import {
  FIELD_SELECTOR,
  currentFocusOrigin,
  focusElement,
  focusProgrammatically,
  isVisibleForFocus,
  tabbables,
  trackLastFocused,
  uid,
} from '@/utils/a11y/focus'
import {
  inertOthers,
  isInManagedInert,
  isTopLayerElement,
  lockScroll as lockBodyScroll,
  pushLayer,
  resolveFocusOrigin,
} from '@/utils/a11y/layers'

export type InitialFocus = 'auto' | 'dialog' | string | HTMLElement | null | undefined

export interface UseDialogOptions {
  open: MaybeRefOrGetter<boolean>
  element: Ref<HTMLElement | null | undefined>
  /** Escape while topmost. */
  onClose?: () => void
  /** False: Escape is swallowed and the dialog stays open. Default true. */
  closeOnEscape?: MaybeRefOrGetter<boolean>
  /** 'auto' (default), 'dialog', a selector inside the dialog, or an element. */
  initialFocus?: MaybeRefOrGetter<InitialFocus>
  /** Fallback restore target; false disables focus restore. */
  returnFocus?: MaybeRefOrGetter<HTMLElement | null | undefined | false>
  /** Default true. */
  inertBackground?: boolean
  /** Default true. */
  lockScroll?: boolean
}

// Dialog element -> its opener, for the fallback when an opener unmounts with
// the dialog it sat in.
const openers = new WeakMap<Element, HTMLElement | null>()

function usable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && isVisibleForFocus(el)
}

/** Moves focus into `root` per `initial`. */
export function focusDialogStart(root: HTMLElement, initial: InitialFocus = 'auto'): void {
  if (initial instanceof HTMLElement) {
    if (focusElement(initial)) return
  } else if (typeof initial === 'string' && initial !== 'auto' && initial !== 'dialog') {
    const target = root.querySelector<HTMLElement>(initial)
    if (target && focusProgrammatically(target)) return
  } else if (initial !== 'dialog') {
    const preferred = root.querySelector<HTMLElement>('[data-autofocus], [autofocus]')
    if (preferred && isVisibleForFocus(preferred) && focusProgrammatically(preferred)) return
    const field = Array.from(root.querySelectorAll<HTMLElement>(FIELD_SELECTOR)).find(isVisibleForFocus)
    if (field && focusElement(field)) return
  }
  focusProgrammatically(root)
}

/** Tab/Shift+Tab wrap for `root`; focus in a popover outside it is left alone. */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  const active = document.activeElement
  const inside = active instanceof Node && root.contains(active)
  const lost = !active || active === document.body || active === document.documentElement
  if (!inside && !lost) return
  const items = tabbables(root)
  if (items.length === 0) {
    event.preventDefault()
    focusProgrammatically(root)
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && (!inside || active === first || active === root)) {
    event.preventDefault()
    focusElement(last)
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault()
    focusElement(first)
  }
}

export function useDialog(options: UseDialogOptions) {
  trackLastFocused()

  const titleId = uid('dialog-title')
  const descriptionId = uid('dialog-desc')
  const active = ref(false)

  let opener: HTMLElement | null = null
  let fallbackOpener: HTMLElement | null = null
  let activeEl: HTMLElement | null = null
  let cleanups: Array<() => void> = []

  const captureOpener = () => {
    opener = resolveFocusOrigin(currentFocusOrigin())
    fallbackOpener = null
    const host = opener?.closest('[role="dialog"], [role="alertdialog"]')
    if (host && host !== opener) fallbackOpener = openers.get(host) ?? null
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !activeEl || !isTopLayerElement(activeEl)) return
    trapTab(event, activeEl)
  }

  // Focus landing behind the dialog (inert unsupported) comes back.
  const onFocusIn = (event: FocusEvent) => {
    if (!activeEl || !isTopLayerElement(activeEl)) return
    const target = event.target
    if (target instanceof Node && !activeEl.contains(target) && isInManagedInert(target)) {
      focusProgrammatically(activeEl)
    }
  }

  const activate = (el: HTMLElement) => {
    activeEl = el
    active.value = true
    openers.set(el, opener)
    cleanups.push(
      pushLayer({
        kind: 'dialog',
        element: () => el,
        onEscape: () => {
          if (toValue(options.closeOnEscape) !== false) options.onClose?.()
        },
      }),
    )
    if (options.inertBackground !== false) cleanups.push(inertOthers([el]))
    if (options.lockScroll !== false) cleanups.push(lockBodyScroll())
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('focusin', onFocusIn, true)
    cleanups.push(() => {
      document.removeEventListener('keydown', onKeydown, true)
      document.removeEventListener('focusin', onFocusIn, true)
    })
    if (!el.contains(document.activeElement)) focusDialogStart(el, toValue(options.initialFocus))
  }

  const deactivate = (restore = true) => {
    const el = activeEl
    activeEl = null
    active.value = false
    cleanups.forEach((fn) => fn())
    cleanups = []
    const fallback = toValue(options.returnFocus)
    if (!restore || fallback === false) return
    const focus = document.activeElement
    const lost = !focus || focus === document.body || focus === document.documentElement || !!el?.contains(focus)
    if (!lost) return
    const target = [opener, fallbackOpener, fallback || null].find(usable)
    if (target) focusElement(target)
  }

  watch(
    () => toValue(options.open),
    (open, wasOpen) => {
      if (open && !wasOpen) captureOpener()
    },
    { flush: 'sync', immediate: true },
  )

  watch(
    [() => toValue(options.open), options.element],
    ([open, el]) => {
      if (open && el && !active.value) activate(el)
      else if (active.value && (!open || !el || el !== activeEl)) {
        const swapped = !!open && !!el
        deactivate(!swapped)
        if (swapped) activate(el)
      }
    },
    { flush: 'post', immediate: true },
  )

  onBeforeUnmount(() => {
    if (active.value) deactivate()
  })

  return {
    titleId,
    descriptionId,
    isActive: active,
    /** Re-runs initial focus, e.g. after async content replaced a loading state. */
    focusInitial: () => {
      if (activeEl) focusDialogStart(activeEl, toValue(options.initialFocus))
    },
  }
}
