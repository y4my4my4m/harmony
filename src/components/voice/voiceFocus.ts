// Focus targets for voice surfaces that unmount the control a keyboard user
// was on (leaving a call, collapsing the call view, closing a popover).

import { MAIN_CONTENT_ID } from '@/composables/useRouteA11y'
import { focusElement, focusProgrammatically } from '@/utils/a11y/focus'

/** True when focus sits on <body> or on an element no longer in the document. */
export function focusIsLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || active === document.documentElement || !active.isConnected
}

/** Focuses `target` when focus was lost; returns whether it moved. */
export function restoreFocusIfLost(target: HTMLElement | null | undefined): boolean {
  if (!target?.isConnected || !focusIsLost()) return false
  return focusElement(target)
}

/**
 * After leaving a call: the channel's row in the sidebar, else the main
 * region. Only when focus was lost with the control that left.
 */
export function focusAfterVoiceLeave(channelId: string | null | undefined): void {
  if (!focusIsLost()) return
  const row = channelId
    ? document.querySelector<HTMLElement>(`[data-channel-id="${CSS.escape(channelId)}"] [role="button"], [data-channel-id="${CSS.escape(channelId)}"] button`)
    : null
  if (row && focusElement(row)) return
  const main = document.getElementById(MAIN_CONTENT_ID) ?? document.querySelector<HTMLElement>('main, [role="main"]')
  if (main) focusProgrammatically(main)
}
