/**
 * Keyboard and screen-reader model shared by the emoji pickers (EmojiPopup,
 * EmojiPickerContent).
 *
 *   const { onGridKeydown, onSearchKeydown } = useEmojiPickerA11y(contentRef, activeQuery, () => count)
 *   <input @keydown="onSearchKeydown"> ... <div ref="contentRef" @keydown="onGridKeydown">
 *
 * - Emoji are `.emoji-item` buttons, rendered with tabindex="-1", in one grid
 *   with a single tab stop. Arrows move between them (columns read from the
 *   rendered `.emoji-list` grid), Home/End go to the start or end of the row,
 *   Ctrl+Home/End to the ends; Up from the first row returns to the search.
 * - In the search field ArrowDown moves to the first emoji and Enter picks it.
 * - Once a query settles, the number of results is announced.
 *
 * Deviation from useRovingTabindex: that composable rewrites every item's
 * tabindex on each update of the host component, and a picker holds thousands
 * of emoji (a hover re-renders it). Here only the tab stop's two items are
 * written, at key presses, and the first emoji becomes the stop when none is.
 */

import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { announce } from '@/composables/useAnnouncer'
import { useT } from '@/composables/useT'
import { focusElement } from '@/utils/a11y/focus'

/** Grid width when no grid is rendered: 320 px popup, 36 px cells, 6 px gaps. */
const FALLBACK_COLUMNS = 7

const ITEM = '.emoji-item'
const ENABLED = `${ITEM}:not([aria-disabled="true"])`

export function useEmojiPickerA11y(
  content: Ref<HTMLElement | null>,
  activeQuery: Ref<string>,
  resultCount: () => number,
) {
  const { t } = useT()

  const columns = (): number => {
    const grid = content.value?.querySelector<HTMLElement>('.emoji-list')
    if (!grid || typeof getComputedStyle === 'undefined') return FALLBACK_COLUMNS
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter((track) => track && track !== 'none').length
    return tracks > 0 ? tracks : FALLBACK_COLUMNS
  }

  const setStop = (item: HTMLElement) => {
    content.value?.querySelectorAll<HTMLElement>(`${ITEM}[tabindex="0"]`).forEach((other) => {
      if (other !== item) other.setAttribute('tabindex', '-1')
    })
    item.setAttribute('tabindex', '0')
  }

  const ensureStop = () => {
    const root = content.value
    if (!root || root.querySelector(`${ITEM}[tabindex="0"]`)) return
    root.querySelector<HTMLElement>(ENABLED)?.setAttribute('tabindex', '0')
  }

  const moveTo = (item: HTMLElement | undefined) => {
    if (!item) return
    setStop(item)
    focusElement(item)
    item.scrollIntoView?.({ block: 'nearest' })
  }

  const onGridKeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (!target?.matches(ITEM) || event.altKey || event.metaKey) return
    const list = Array.from(content.value?.querySelectorAll<HTMLElement>(ENABLED) ?? [])
    const index = list.indexOf(target)
    if (index < 0) return
    const cols = columns()
    let next: number
    switch (event.key) {
      case 'ArrowRight': next = index + 1; break
      case 'ArrowLeft': next = index - 1; break
      case 'ArrowDown': next = index + cols < list.length ? index + cols : index; break
      case 'ArrowUp':
        if (index - cols < 0) {
          const search = content.value?.parentElement?.querySelector<HTMLElement>('input.search-input')
          if (search) {
            event.preventDefault()
            focusElement(search)
          }
          return
        }
        next = index - cols
        break
      case 'Home': next = event.ctrlKey ? 0 : index - (index % cols); break
      case 'End': next = event.ctrlKey ? list.length - 1 : Math.min(list.length - 1, index - (index % cols) + cols - 1); break
      default: return
    }
    event.preventDefault()
    moveTo(list[Math.max(0, Math.min(list.length - 1, next))])
  }

  const onSearchKeydown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const first = content.value?.querySelector<HTMLElement>(ENABLED) ?? null
    if (!first) return
    if (event.key === 'Enter') {
      event.preventDefault()
      first.click()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTo(first)
    }
  }

  // Sections mount lazily and results replace each other; the first emoji
  // becomes the tab stop whenever none is. No pass runs per render: a picker
  // re-renders on every hover.
  let observer: MutationObserver | null = null
  onMounted(() => {
    ensureStop()
    if (!content.value || typeof MutationObserver === 'undefined') return
    observer = new MutationObserver(ensureStop)
    observer.observe(content.value, { childList: true, subtree: true })
  })
  onBeforeUnmount(() => observer?.disconnect())

  watch(activeQuery, (query) => {
    if (!query) return
    void nextTick(() => {
      const count = resultCount()
      announce(
        count > 0 ? t('messageA11y.emoji.results', { count }, count) : t('messageA11y.emoji.noResults'),
        { key: 'emoji-results', dedupeMs: 0 },
      )
    })
  })

  return { onGridKeydown, onSearchKeydown }
}
