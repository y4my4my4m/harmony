/**
 * Roving tabindex: one Tab stop for a composite widget, arrow keys move focus
 * between its items. The active item has tabindex="0", every other item "-1".
 *
 *   const list = ref<HTMLElement | null>(null)
 *   const { onKeydown } = useRovingTabindex(list, { itemSelector: '[role="option"]', orientation: 'vertical' })
 *   <div ref="list" role="listbox" @keydown="onKeydown"> ... </div>
 *
 * Options:
 *   itemSelector  items inside the container. Disabled ones ([disabled],
 *                 [aria-disabled="true"]), unrendered ones ([hidden], [inert],
 *                 display: none on them or an ancestor) and those inside a menu,
 *                 listbox or dialog rendered in the container are skipped.
 *                 Default '[data-roving-item]'.
 *   focusableDisabled  aria-disabled items stay items, as in a toolbar, where
 *                 they remain focusable (APG). Default false.
 *   orientation   'vertical' (Up/Down), 'horizontal' (Left/Right; mirrored in RTL),
 *                 'both' (all four, list order), 'grid' (Left/Right in a row,
 *                 Up/Down by `columns`).
 *   columns       grid width, a number or a getter (responsive grids).
 *   loop          wrap at the ends. Default true; grids clamp.
 *   typeahead     printable keys jump to the next item whose text starts with
 *                 the typed prefix (500 ms buffer). Default false.
 *   homeEnd       Home/End move. Default true; false leaves them to an
 *                 enclosing widget (a toolbar inside a list item).
 *   pageSize      PageUp/PageDown step in items. Absent: the keys are not handled.
 *   onActivate    called with the item when focus moves to it.
 *   onEnter       Enter (no Shift or Ctrl) on an item itself.
 *   onContextMenu the ContextMenu key or Shift+F10 on an item itself.
 *   onBoundary    a move past the first (-1) or last (1) item of a list that
 *                 does not loop.
 *   virtual       the rendered items are a window over `count()` positions:
 *                 moves are computed over positions and `focusIndex` focuses
 *                 one, rendering it first when it is outside the window.
 *   initialIndex  getter for the item that holds tabindex="0" before any key
 *                 (e.g. the selected one). Default: [aria-selected="true"],
 *                 [aria-current], [aria-checked="true"], else the first item.
 *
 * Keys pressed on a control inside an item act as if pressed on the item, and
 * Escape there focuses the item; controls that use those keys themselves
 * (KEY_OWNER_SELECTOR) keep them. Enter, the context menu key and typeahead
 * stay with the control. A keydown already defaultPrevented (a nested toolbar
 * moved focus) is ignored, as are Alt and Meta chords.
 *
 * Tree (role="tree"): orientation 'vertical'; Right/Left are left to the
 * component (expand/collapse) and only Up/Down/Home/End move here.
 *
 * Home/End go to the first/last item (Ctrl+Home/End in a grid; elsewhere
 * Ctrl+Home/End are left to the page, where a feed leaves on them). The Tab
 * stop stays where it was when the item moved to refuses focus. The tabindex
 * values are rewritten on every key and by `sync()`; call sync() after the
 * item list changes. An item an enclosing list has parked out of the Tab
 * sequence (PARKED_ATTR) keeps tabindex="-1"; its value is written to the
 * attribute instead and restored by that list.
 */

import { onMounted, onUpdated, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import { focusElement } from '@/utils/a11y/focus'
import { isContextMenuKey } from '@/composables/useMenu'

export interface RovingVirtual {
  count: () => number
  indexOf: (item: HTMLElement) => number
  focusIndex: (index: number) => void
}

export interface RovingOptions {
  itemSelector?: string
  orientation?: 'vertical' | 'horizontal' | 'both' | 'grid'
  columns?: MaybeRefOrGetter<number>
  loop?: boolean
  typeahead?: boolean
  homeEnd?: boolean
  focusableDisabled?: boolean
  pageSize?: () => number
  onActivate?: (item: HTMLElement, index: number) => void
  onEnter?: (item: HTMLElement, event: KeyboardEvent) => void
  onContextMenu?: (item: HTMLElement, event: KeyboardEvent) => void
  onBoundary?: (direction: -1 | 1) => void
  virtual?: RovingVirtual
  initialIndex?: (items: HTMLElement[]) => number
}

/** Holds the tabindex an enclosing list took away; '' for none. */
export const PARKED_ATTR = 'data-roving-muted'

/** Controls that use arrow keys, Home/End or Escape themselves. */
export const KEY_OWNER_SELECTOR = [
  'input',
  'textarea',
  'select',
  'audio',
  'video',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="grid"]',
  '[role="tree"]',
  '[role="tablist"]',
  '[role="radiogroup"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ')

/** A popup rendered inside the container; its controls are not items. */
const POPUP_SELECTOR = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]'

const TYPEAHEAD_MS = 500

function defaultInitial(items: HTMLElement[]): number {
  const i = items.findIndex((el) =>
    el.matches('[aria-selected="true"], [aria-current]:not([aria-current="false"]), [aria-checked="true"]'),
  )
  return i >= 0 ? i : 0
}

const tabindexOf = (el: HTMLElement): string | null => el.getAttribute(PARKED_ATTR) ?? el.getAttribute('tabindex')

/** True when `target`, inside `item`, sits in a control that handles the key itself. */
function keyOwnedInside(target: Element, item: HTMLElement): boolean {
  if (target instanceof HTMLElement && target.isContentEditable) return true
  const owner = target.closest(KEY_OWNER_SELECTOR)
  return !!owner && owner !== item && item.contains(owner)
}

export function useRovingTabindex(container: Ref<HTMLElement | null | undefined>, options: RovingOptions = {}) {
  const selector = options.itemSelector ?? '[data-roving-item]'
  const orientation = options.orientation ?? 'vertical'
  const loop = options.loop ?? orientation !== 'grid'
  const homeEnd = options.homeEnd ?? true
  const skipSelector = options.focusableDisabled ? '[disabled]' : '[disabled], [aria-disabled="true"]'
  let buffer = ''
  let bufferAt = 0

  const items = (): HTMLElement[] => {
    const root = container.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => {
      if (el.matches(skipSelector) || el.closest('[hidden], [inert]')) return false
      const popup = el.closest(POPUP_SELECTOR)
      if (popup && popup !== root && root.contains(popup)) return false
      // No boxes: display: none on the item or an ancestor. happy-dom reports one box for every element.
      return el.getClientRects().length > 0
    })
  }

  const attrOf = (el: HTMLElement) => (el.hasAttribute(PARKED_ATTR) ? PARKED_ATTR : 'tabindex')

  const setActive = (list: HTMLElement[], index: number) => {
    list.forEach((el, i) => el.setAttribute(attrOf(el), i === index ? '0' : '-1'))
  }

  /** Re-applies tabindex values, keeping the focused item, else the initial one, active. */
  const sync = () => {
    const list = items()
    if (list.length === 0) return
    const focused = list.findIndex((el) => el === document.activeElement || el.contains(document.activeElement))
    const zeros = list.filter((el) => tabindexOf(el) === '0')
    let index = focused
    if (index < 0) index = zeros.length === 1 ? list.indexOf(zeros[0]) : (options.initialIndex ?? defaultInitial)(list)
    setActive(list, Math.max(0, Math.min(index, list.length - 1)))
  }

  // tabindex is written before focus(): an item without one is not focusable.
  const moveTo = (list: HTMLElement[], index: number) => {
    const item = list[index]
    if (!item) return
    const previous = list.map((el) => el.getAttribute(attrOf(el)))
    setActive(list, index)
    if (!focusElement(item) && !item.contains(document.activeElement)) {
      list.forEach((el, i) => {
        const value = previous[i]
        if (value === null) el.removeAttribute(attrOf(el))
        else el.setAttribute(attrOf(el), value)
      })
      return
    }
    options.onActivate?.(item, index)
  }

  const step = (index: number, delta: -1 | 1, length: number) => {
    const next = index + delta
    if (loop) return (next + length) % length
    if (next < 0 || next >= length) options.onBoundary?.(delta)
    return Math.max(0, Math.min(length - 1, next))
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.metaKey) return
    const list = items()
    if (list.length === 0) return
    const target = event.target as HTMLElement | null
    const at = list.findIndex((el) => el === target || (target ? el.contains(target) : false))
    if (at < 0 || !target) return
    const item = list[at]
    const inner = target !== item
    if (inner && keyOwnedInside(target, item)) return

    const virtual = options.virtual
    const index = virtual ? virtual.indexOf(item) : at
    const length = virtual ? virtual.count() : list.length
    if (index < 0 || length === 0) return
    const focusIndex = (n: number) => (virtual ? virtual.focusIndex(n) : moveTo(list, n))

    if (event.key === 'Escape') {
      if (!inner || event.shiftKey || event.ctrlKey) return
      event.preventDefault()
      focusIndex(index)
      return
    }
    if (!inner && options.onContextMenu && isContextMenuKey(event)) {
      event.preventDefault()
      options.onContextMenu(item, event)
      return
    }
    if (!inner && options.onEnter && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
      event.preventDefault()
      options.onEnter(item, event)
      return
    }

    const rtl = getComputedStyle(container.value ?? document.documentElement).direction === 'rtl'
    const columns = Math.max(1, toValue(options.columns) ?? 1)
    let next: number | null = null

    switch (event.key) {
      case 'ArrowDown':
        if (orientation === 'vertical' || orientation === 'both') next = step(index, 1, length)
        else if (orientation === 'grid') next = index + columns < length ? index + columns : index
        break
      case 'ArrowUp':
        if (orientation === 'vertical' || orientation === 'both') next = step(index, -1, length)
        else if (orientation === 'grid') next = index - columns >= 0 ? index - columns : index
        break
      case 'ArrowRight':
        if (orientation === 'horizontal' || orientation === 'both' || orientation === 'grid') {
          next = step(index, rtl ? -1 : 1, length)
        }
        break
      case 'ArrowLeft':
        if (orientation === 'horizontal' || orientation === 'both' || orientation === 'grid') {
          next = step(index, rtl ? 1 : -1, length)
        }
        break
      case 'PageUp':
      case 'PageDown': {
        if (!options.pageSize || event.ctrlKey || event.shiftKey) return
        const delta = (event.key === 'PageUp' ? -1 : 1) * Math.max(1, options.pageSize())
        if (index + delta < 0 || index + delta >= length) options.onBoundary?.(delta < 0 ? -1 : 1)
        next = Math.max(0, Math.min(length - 1, index + delta))
        break
      }
      case 'Home':
        if (!homeEnd || (orientation !== 'grid' && event.ctrlKey)) return
        if (orientation !== 'grid' || event.ctrlKey) next = 0
        else next = index - (index % columns)
        break
      case 'End':
        if (!homeEnd || (orientation !== 'grid' && event.ctrlKey)) return
        if (orientation !== 'grid' || event.ctrlKey) next = length - 1
        else next = Math.min(length - 1, index - (index % columns) + columns - 1)
        break
      default:
        if (!inner && options.typeahead && event.key.length === 1 && !event.ctrlKey && /\S/.test(event.key)) {
          const now = Date.now()
          buffer = now - bufferAt > TYPEAHEAD_MS ? event.key.toLowerCase() : buffer + event.key.toLowerCase()
          bufferAt = now
          const order = [...list.slice(at + (buffer.length === 1 ? 1 : 0)), ...list.slice(0, at + (buffer.length === 1 ? 1 : 0))]
          const hit = order.find((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase().startsWith(buffer))
          if (hit) {
            event.preventDefault()
            moveTo(list, list.indexOf(hit))
          }
        }
        return
    }
    if (next === null) return
    event.preventDefault()
    if (next !== index || inner) focusIndex(next)
  }

  onMounted(sync)
  onUpdated(sync)

  return { onKeydown, sync, items, focusItem: (index: number) => moveTo(items(), index) }
}
