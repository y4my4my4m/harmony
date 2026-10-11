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
 *                 [aria-disabled="true"]) are skipped. Default '[data-roving-item]'.
 *   orientation   'vertical' (Up/Down), 'horizontal' (Left/Right; mirrored in RTL),
 *                 'both' (all four, list order), 'grid' (Left/Right in a row,
 *                 Up/Down by `columns`).
 *   columns       grid width, a number or a getter (responsive grids).
 *   loop          wrap at the ends. Default true; grids clamp.
 *   typeahead     printable keys jump to the next item whose text starts with
 *                 the typed prefix (500 ms buffer). Default false.
 *   onActivate    called with the item when focus moves to it.
 *   initialIndex  getter for the item that holds tabindex="0" before any key
 *                 (e.g. the selected one). Default: [aria-selected="true"],
 *                 [aria-current], [aria-checked="true"], else the first item.
 *
 * Tree (role="tree"): orientation 'vertical'; Right/Left are left to the
 * component (expand/collapse) and only Up/Down/Home/End move here.
 *
 * Home/End go to the first/last item (Ctrl+Home/End in a grid). The tabindex
 * values are rewritten on every key and by `sync()`; call sync() after the
 * item list changes.
 */

import { onMounted, onUpdated, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import { focusElement } from '@/utils/a11y/focus'

export interface RovingOptions {
  itemSelector?: string
  orientation?: 'vertical' | 'horizontal' | 'both' | 'grid'
  columns?: MaybeRefOrGetter<number>
  loop?: boolean
  typeahead?: boolean
  onActivate?: (item: HTMLElement, index: number) => void
  initialIndex?: (items: HTMLElement[]) => number
}

const TYPEAHEAD_MS = 500

function defaultInitial(items: HTMLElement[]): number {
  const i = items.findIndex((el) =>
    el.matches('[aria-selected="true"], [aria-current]:not([aria-current="false"]), [aria-checked="true"]'),
  )
  return i >= 0 ? i : 0
}

export function useRovingTabindex(container: Ref<HTMLElement | null | undefined>, options: RovingOptions = {}) {
  const selector = options.itemSelector ?? '[data-roving-item]'
  const orientation = options.orientation ?? 'vertical'
  const loop = options.loop ?? orientation !== 'grid'
  let buffer = ''
  let bufferAt = 0

  const items = (): HTMLElement[] => {
    const root = container.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => !el.matches('[disabled], [aria-disabled="true"]') && !el.closest('[hidden], [inert]'),
    )
  }

  const setActive = (list: HTMLElement[], index: number) => {
    list.forEach((el, i) => el.setAttribute('tabindex', i === index ? '0' : '-1'))
  }

  /** Re-applies tabindex values, keeping the focused item, else the initial one, active. */
  const sync = () => {
    const list = items()
    if (list.length === 0) return
    const focused = list.findIndex((el) => el === document.activeElement || el.contains(document.activeElement))
    const zeros = list.filter((el) => el.getAttribute('tabindex') === '0')
    let index = focused
    if (index < 0) index = zeros.length === 1 ? list.indexOf(zeros[0]) : (options.initialIndex ?? defaultInitial)(list)
    setActive(list, Math.max(0, Math.min(index, list.length - 1)))
  }

  const moveTo = (list: HTMLElement[], index: number) => {
    const item = list[index]
    if (!item) return
    setActive(list, index)
    focusElement(item)
    options.onActivate?.(item, index)
  }

  const step = (index: number, delta: number, length: number) => {
    const next = index + delta
    if (loop) return (next + length) % length
    return Math.max(0, Math.min(length - 1, next))
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.altKey || event.metaKey) return
    const list = items()
    if (list.length === 0) return
    const target = event.target as HTMLElement | null
    const index = list.findIndex((el) => el === target || (target ? el.contains(target) : false))
    if (index < 0) return
    const rtl = getComputedStyle(container.value ?? document.documentElement).direction === 'rtl'
    const columns = Math.max(1, toValue(options.columns) ?? 1)
    let next: number | null = null

    switch (event.key) {
      case 'ArrowDown':
        if (orientation === 'vertical' || orientation === 'both') next = step(index, 1, list.length)
        else if (orientation === 'grid') next = index + columns < list.length ? index + columns : index
        break
      case 'ArrowUp':
        if (orientation === 'vertical' || orientation === 'both') next = step(index, -1, list.length)
        else if (orientation === 'grid') next = index - columns >= 0 ? index - columns : index
        break
      case 'ArrowRight':
        if (orientation === 'horizontal' || orientation === 'both' || orientation === 'grid') {
          next = step(index, rtl ? -1 : 1, list.length)
        }
        break
      case 'ArrowLeft':
        if (orientation === 'horizontal' || orientation === 'both' || orientation === 'grid') {
          next = step(index, rtl ? 1 : -1, list.length)
        }
        break
      case 'Home':
        if (orientation !== 'grid' || event.ctrlKey) next = 0
        else next = index - (index % columns)
        break
      case 'End':
        if (orientation !== 'grid' || event.ctrlKey) next = list.length - 1
        else next = Math.min(list.length - 1, index - (index % columns) + columns - 1)
        break
      default:
        if (options.typeahead && event.key.length === 1 && !event.ctrlKey && /\S/.test(event.key)) {
          const now = Date.now()
          buffer = now - bufferAt > TYPEAHEAD_MS ? event.key.toLowerCase() : buffer + event.key.toLowerCase()
          bufferAt = now
          const order = [...list.slice(index + (buffer.length === 1 ? 1 : 0)), ...list.slice(0, index + (buffer.length === 1 ? 1 : 0))]
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
    if (next !== index) moveTo(list, next)
  }

  onMounted(sync)
  onUpdated(sync)

  return { onKeydown, sync, items, focusItem: (index: number) => moveTo(items(), index) }
}
