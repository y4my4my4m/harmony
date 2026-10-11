// document.title is composed here and nowhere else:
//   "(unread) view – instance"
// The notification store sets the unread count, the instance settings store
// the instance name, and the route (useRouteA11y / useViewTitle) the view.

import { computed, reactive } from 'vue'

const parts = reactive({
  unread: 0,
  instance: 'Harmony',
  routeTitle: '',
  overrides: [] as Array<{ id: symbol; get: () => string }>,
})

/** The current view's title: the newest useViewTitle override, else the route's. */
export const viewTitle = computed(() => {
  for (let i = parts.overrides.length - 1; i >= 0; i--) {
    const text = parts.overrides[i].get()
    if (text) return text
  }
  return parts.routeTitle
})

export const composedTitle = computed(() => {
  const base = viewTitle.value ? `${viewTitle.value} – ${parts.instance}` : parts.instance
  return parts.unread > 0 ? `(${parts.unread}) ${base}` : base
})

function apply() {
  if (typeof document !== 'undefined') document.title = composedTitle.value
}

export function setTitleUnread(count: number): void {
  parts.unread = Math.max(0, count | 0)
  apply()
}

export function setTitleInstance(name: string | null | undefined): void {
  parts.instance = name || 'Harmony'
  apply()
}

export function setRouteTitle(text: string): void {
  parts.routeTitle = text
  apply()
}

/** Registers a dynamic view title; returns its removal. */
export function pushViewTitle(get: () => string): () => void {
  const entry = { id: Symbol('view-title'), get }
  parts.overrides.push(entry)
  apply()
  return () => {
    const i = parts.overrides.findIndex((o) => o.id === entry.id)
    if (i >= 0) parts.overrides.splice(i, 1)
    apply()
  }
}

/** Re-applies after a reactive override changed. */
export function refreshDocumentTitle(): void {
  apply()
}
