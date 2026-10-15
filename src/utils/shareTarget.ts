import type { LocationQuery, Router } from 'vue-router'

/** Web Share Target fields, as named in the manifest's share_target.params. */
export interface SharedPayload {
  title: string
  text: string
  url: string
}

export const SHARE_PATH = '/share'

function firstString(value: LocationQuery[string]): string {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v.trim() : ''
}

export function sharedPayloadFromQuery(query: LocationQuery): SharedPayload {
  return {
    title: firstString(query.title),
    text: firstString(query.text),
    url: firstString(query.url),
  }
}

/**
 * Message text for a share: title, text and url on their own lines. Android
 * puts the link in `text` and the page title in `title`; a field another one
 * already contains is dropped.
 */
export function composeSharedText({ title, text, url }: SharedPayload): string {
  const link = url && !text.includes(url) ? url : ''
  const head = title && !text.includes(title) && title !== link ? title : ''
  return [head, text, link].filter(Boolean).join('\n')
}

/** Shared text after an existing draft, on a new line; the draft is kept. */
export function appendToDraft(draft: string, shared: string): string {
  const kept = draft.replace(/\s+$/, '')
  return kept.trim() ? `${kept}\n${shared}` : shared
}

export interface ShareChannelRow {
  id: string
  name: string
  type: number
  order: number | null
  category: string | null
}

export interface ShareCategoryRow {
  id: string
  order: number | null
}

/**
 * Text channels (type 0) in sidebar order: uncategorised first, then each
 * category in its order; channels by their order within each group.
 */
export function orderTextChannels(channels: ShareChannelRow[], categories: ShareCategoryRow[]): ShareChannelRow[] {
  const byOrder = <T extends { order: number | null }>(a: T, b: T) => (a.order ?? 0) - (b.order ?? 0)
  const text = channels.filter((c) => Number(c.type) === 0)
  const rank = new Map([...categories].sort(byOrder).map((c, i) => [c.id, i]))
  const groupOf = (c: ShareChannelRow) => (c.category === null ? -1 : rank.get(c.category) ?? rank.size)
  return [...text].sort((a, b) => groupOf(a) - groupOf(b) || byOrder(a, b))
}

interface LaunchParams {
  targetURL?: string
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}

/**
 * Routes share launches that reach an open window. launch_handler
 * `focus-existing` focuses that window without navigating it and hands the
 * share URL to window.launchQueue instead.
 */
export function installShareLaunchConsumer(router: Router): void {
  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue
  if (!queue) return
  queue.setConsumer((params) => {
    if (!params.targetURL) return
    let target: URL
    try {
      target = new URL(params.targetURL)
    } catch {
      return
    }
    if (target.origin !== window.location.origin || target.pathname !== SHARE_PATH) return
    if (target.href === window.location.href) return
    void router.push(target.pathname + target.search)
  })
}
