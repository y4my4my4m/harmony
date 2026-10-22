// Route-leave guard for a view holding unsaved edits: leaving asks first.
//
// A push or replace waits in the guard for the answer. A history traversal (Back, the
// Android back gesture) has already moved the history when the guard runs, and a prompt
// opened then would push its Back entry (utils/overlayHistory.ts) onto the destination.
// The guard refuses the traversal, vue-router's go(-delta) restores the view's entry, and
// the prompt opens once that popstate lands. Discard repeats the traversal.

import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { overlayHistorySettled } from '@/utils/overlayHistory'

// A restoring go() whose popstate never arrives must not hold the prompt forever.
const RESTORE_TIMEOUT_MS = 600

function positionOf(state: unknown): number | null {
  const position = (state as { position?: unknown } | null)?.position
  return typeof position === 'number' ? position : null
}

function nextPopState(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      window.removeEventListener('popstate', done)
      resolve()
    }
    const timer = setTimeout(done, RESTORE_TIMEOUT_MS)
    window.addEventListener('popstate', done)
  })
}

export interface UnsavedLeaveGuardOptions {
  dirty: () => boolean
  /** The discard prompt; resolves true to discard. */
  ask: () => Promise<boolean>
}

export function useUnsavedLeaveGuard(options: UnsavedLeaveGuardOptions) {
  const router = useRouter()
  let asking = false
  let restoring = false
  let discarded = false

  /**
   * True when nothing is unsaved or the user discards; every later leave then passes.
   * False on Cancel and while another prompt is open.
   */
  async function confirmLeave(): Promise<boolean> {
    if (discarded || !options.dirty()) return true
    if (asking) return false
    asking = true
    try {
      discarded = await options.ask()
      return discarded
    } finally {
      asking = false
    }
  }

  /** `target`: history.state.position the refused traversal was headed to. */
  async function askThenTraverse(target: number | null): Promise<void> {
    if (restoring) return
    restoring = true
    try {
      await nextPopState()
    } finally {
      restoring = false
    }
    if (!(await confirmLeave())) return
    await overlayHistorySettled()
    const current = positionOf(window.history.state)
    router.go(target !== null && current !== null && target !== current ? target - current : -1)
  }

  onBeforeRouteLeave((to) => {
    if (discarded || !options.dirty()) return true
    // On a traversal the router's location already is the destination.
    if (router.options.history.location !== to.fullPath) return confirmLeave()
    void askThenTraverse(positionOf(window.history.state))
    return false
  })

  return { confirmLeave }
}
