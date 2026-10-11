/**
 * Menu keyboard model (WAI-ARIA menu pattern), extracted from the server rail's
 * RailMenu. components/a11y/AppMenu.vue renders it; use the composable directly when
 * a menu keeps its own markup.
 *
 *   const menuEl = ref<HTMLElement | null>(null)
 *   useMenu(menuEl, { onClose: (reason) => emit('close', reason) })
 *   <div ref="menuEl" role="menu" :aria-label="label">
 *     <button role="menuitem">...</button>
 *     <div class="menu-sub" role="none">            submenu: wrapper holds the
 *       <button role="menuitem" aria-haspopup="menu">  owner item and a nested
 *       <div role="menu">...</div>                     role="menu"
 *     </div>
 *   </div>
 *
 * While open (mounted, or `open` true):
 * - focus goes to the first enabled item (initialFocus 'last' for ArrowUp
 *   openers, 'none' to leave it);
 * - Up/Down wrap, Home/End, printable keys jump by label (typeahead);
 * - Right on an item with aria-haspopup="menu" opens its submenu (class `open`
 *   and data-open on the wrapper), Left or Escape inside it closes it;
 * - Enter/Space on an item that is not a <button>/<a> clicks it;
 * - Escape (topmost layer only), Tab, a pointer press outside, window blur or
 *   resize call onClose with 'escape' | 'tab' | 'outside' | 'dismiss';
 * - on close, focus returns to the trigger (the element focused when the menu
 *   opened, or options.trigger) unless the close was a pointer press elsewhere
 *   or focus already moved on. A dialog opened from an item restores to that
 *   trigger too (utils/a11y/layers.ts resolveFocusOrigin).
 *
 * Items: [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio];
 * [disabled] and [aria-disabled="true"] are skipped.
 *
 * Triggers: useMenuButton() gives a menu button its ARIA state and keys;
 * isContextMenuKey() recognises the ContextMenu key and Shift+F10 for items
 * that open a context menu from the keyboard.
 */

import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import { currentFocusOrigin, focusElement, trackLastFocused, uid } from '@/utils/a11y/focus'
import { pushLayer, setMenuTrigger } from '@/utils/a11y/layers'

export type MenuCloseReason = 'escape' | 'tab' | 'outside' | 'dismiss' | 'select'

export interface UseMenuOptions {
  open?: MaybeRefOrGetter<boolean>
  onClose: (reason: MenuCloseReason) => void
  /** Element focus returns to; default: the element focused when the menu opened. */
  trigger?: MaybeRefOrGetter<HTMLElement | null | undefined>
  initialFocus?: MaybeRefOrGetter<'first' | 'last' | 'none'>
  /** Default true. */
  closeOnOutsidePointer?: boolean
  /** Default true. */
  typeahead?: boolean
}

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
const TYPEAHEAD_MS = 500

/** Enabled items of `scope` (a menu element), excluding nested submenus' items. */
export function menuItems(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(ITEM)).filter(
    (el) => !el.matches('[disabled], [aria-disabled="true"]') && el.closest('[role="menu"]') === scope && !el.closest('[hidden]'),
  )
}

/** ContextMenu key or Shift+F10. */
export function isContextMenuKey(event: KeyboardEvent): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
}

function itemLabel(el: HTMLElement): string {
  return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function submenuOf(item: HTMLElement): HTMLElement | null {
  return item.parentElement?.querySelector<HTMLElement>(':scope > [role="menu"]') ?? null
}

function setSubmenuOpen(owner: HTMLElement, open: boolean) {
  const wrapper = owner.parentElement
  if (!wrapper) return
  wrapper.classList.toggle('open', open)
  if (open) wrapper.setAttribute('data-open', '')
  else wrapper.removeAttribute('data-open')
  owner.setAttribute('aria-expanded', open ? 'true' : 'false')
}

export function useMenu(menuEl: Ref<HTMLElement | null | undefined>, options: UseMenuOptions) {
  trackLastFocused()

  let trigger: HTMLElement | null = null
  let activeEl: HTMLElement | null = null
  let cleanups: Array<() => void> = []
  let buffer = ''
  let bufferAt = 0
  let closing: MenuCloseReason | null = null

  const close = (reason: MenuCloseReason) => {
    closing = reason
    options.onClose(reason)
  }

  const onKeydown = (event: KeyboardEvent) => {
    const root = activeEl
    if (!root) return
    const target = event.target as HTMLElement
    const scope = (target.closest('[role="menu"]') as HTMLElement | null) ?? root
    const list = menuItems(scope)
    const i = list.indexOf(target)

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (list.length === 0) return
        const d = event.key === 'ArrowDown' ? 1 : -1
        focusElement(list[(i + d + list.length) % list.length] ?? list[0])
        return
      }
      case 'Home':
      case 'End':
        event.preventDefault()
        focusElement(list[event.key === 'Home' ? 0 : list.length - 1])
        return
      case 'ArrowRight': {
        if (target.getAttribute('aria-haspopup') !== 'menu') return
        event.preventDefault()
        const sub = submenuOf(target)
        if (!sub) return
        setSubmenuOpen(target, true)
        focusElement(menuItems(sub)[0])
        return
      }
      case 'ArrowLeft':
      case 'Escape': {
        if (scope === root) return
        event.preventDefault()
        event.stopPropagation()
        const owner = scope.parentElement?.querySelector<HTMLElement>(`:scope > ${ITEM.split(', ').join(', :scope > ')}`)
        if (owner) {
          setSubmenuOpen(owner, false)
          focusElement(owner)
        }
        return
      }
      case 'Tab':
        event.preventDefault()
        close('tab')
        return
      case 'Enter':
      case ' ':
        if (target.matches(ITEM) && !target.matches('button, a[href]')) {
          event.preventDefault()
          target.click()
        }
        return
      default:
        if (options.typeahead !== false && event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now()
          buffer = now - bufferAt > TYPEAHEAD_MS ? event.key.toLowerCase() : buffer + event.key.toLowerCase()
          bufferAt = now
          const start = buffer.length === 1 ? i + 1 : Math.max(i, 0)
          const order = [...list.slice(start), ...list.slice(0, start)]
          const hit = order.find((el) => itemLabel(el).startsWith(buffer))
          if (hit) {
            event.preventDefault()
            focusElement(hit)
          }
        }
    }
  }

  const onPointerDown = (event: PointerEvent) => {
    if (activeEl && !activeEl.contains(event.target as Node)) close('outside')
  }
  const onDismiss = () => close('dismiss')

  const activate = (el: HTMLElement) => {
    activeEl = el
    closing = null
    trigger = toValue(options.trigger) ?? trigger
    setMenuTrigger(el, trigger)
    el.addEventListener('keydown', onKeydown)
    cleanups.push(() => el.removeEventListener('keydown', onKeydown))
    cleanups.push(pushLayer({ kind: 'menu', element: () => el, onEscape: () => close('escape') }))
    if (options.closeOnOutsidePointer !== false) {
      document.addEventListener('pointerdown', onPointerDown, true)
      cleanups.push(() => document.removeEventListener('pointerdown', onPointerDown, true))
    }
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
    cleanups.push(() => {
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('blur', onDismiss)
    })
    const initial = toValue(options.initialFocus) ?? 'first'
    if (initial !== 'none') {
      const list = menuItems(el)
      focusElement(initial === 'last' ? list[list.length - 1] : list[0])
    }
  }

  const deactivate = () => {
    const el = activeEl
    activeEl = null
    cleanups.forEach((fn) => fn())
    cleanups = []
    if (closing === 'outside') return
    const focus = document.activeElement
    const lost = !focus || focus === document.body || !!el?.contains(focus)
    if (lost && trigger?.isConnected) focusElement(trigger)
  }

  watch(
    () => toValue(options.open ?? true),
    (open, wasOpen) => {
      if (open && !wasOpen) trigger = toValue(options.trigger) ?? currentFocusOrigin()
    },
    { flush: 'sync', immediate: true },
  )

  watch(
    [() => toValue(options.open ?? true), menuEl],
    ([open, el]) => {
      if (open && el && el !== activeEl) {
        if (activeEl) deactivate()
        activate(el)
      } else if ((!open || !el) && activeEl) deactivate()
    },
    { flush: 'post', immediate: true },
  )

  onBeforeUnmount(() => {
    if (activeEl) deactivate()
  })

  return { close }
}

/**
 * ARIA state and keys for a button that opens a menu.
 *
 *   const open = ref(false)
 *   const { triggerAttrs, menuId, onTriggerKeydown, initialFocus } = useMenuButton(open)
 *   <button v-bind="triggerAttrs" @click="open = !open" @keydown="onTriggerKeydown">
 *   <AppMenu v-if="open" :id="menuId" :initial-focus="initialFocus" ... />
 *
 * Enter, Space and ArrowDown open with the first item focused, ArrowUp with the
 * last.
 */
export function useMenuButton(open: Ref<boolean>) {
  const menuId = uid('menu')
  const focusLast = ref(false)
  const triggerAttrs = computed(() => ({
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open.value ? 'true' : 'false',
    'aria-controls': open.value ? menuId : undefined,
  }))
  const onTriggerKeydown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusLast.value = event.key === 'ArrowUp'
      open.value = true
    }
  }
  const initialFocus = computed<'first' | 'last'>(() => (focusLast.value ? 'last' : 'first'))
  watch(open, (v) => {
    if (!v) focusLast.value = false
  })
  return { menuId, triggerAttrs, onTriggerKeydown, initialFocus }
}
