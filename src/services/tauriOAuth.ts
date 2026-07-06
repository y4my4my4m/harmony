// OAuth for the native desktop client. Instead of navigating the main
// webview to the provider (which strands the user on an external page with
// no browser chrome to go back), the provider flow runs in a dedicated
// popup window. The popup lands back on /auth/callback, which stores the
// session (storage is shared between same-origin windows), emits a
// completion event, and the main window takes over.

import { debug } from '@/utils/debug'

export const OAUTH_WINDOW_LABEL = 'oauth'
export const OAUTH_COMPLETE_EVENT = 'harmony:oauth-complete'

const POPUP_POLL_INTERVAL_MS = 800

export interface OAuthCompletePayload {
  next: string
}

export async function isOAuthPopup(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().label === OAUTH_WINDOW_LABEL
  } catch {
    return false
  }
}

// Opens the provider URL in a popup window and resolves with the post-login
// route once the callback completes. Rejects with 'oauth-cancelled' if the
// user closes the popup without finishing.
export async function signInViaOAuthPopup(providerUrl: string): Promise<string> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const { listen } = await import('@tauri-apps/api/event')

  const existing = await WebviewWindow.getByLabel(OAUTH_WINDOW_LABEL)
  if (existing) {
    await existing.close().catch(() => undefined)
  }

  const popup = new WebviewWindow(OAUTH_WINDOW_LABEL, {
    url: providerUrl,
    title: 'Sign in to Harmony',
    width: 520,
    height: 720,
    resizable: true,
    center: true,
  })

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let unlisten: (() => void) | undefined

    // The popup can be closed from its native title bar; detect that as a
    // cancel. Window-destroyed events don't reliably cross windows, so poll.
    const pollTimer = setInterval(() => {
      WebviewWindow.getByLabel(OAUTH_WINDOW_LABEL)
        .then((win) => {
          if (!win) settle(() => reject(new Error('oauth-cancelled')))
        })
        .catch(() => undefined)
    }, POPUP_POLL_INTERVAL_MS)

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      unlisten?.()
      clearInterval(pollTimer)
      fn()
    }

    listen<OAuthCompletePayload>(OAUTH_COMPLETE_EVENT, (event) => {
      const next = event.payload?.next || '/chat'
      popup.close().catch(() => undefined)
      settle(() => resolve(next))
    })
      .then((fn) => {
        unlisten = fn
        if (settled) fn()
      })
      .catch((err) => settle(() => reject(err)))

    popup.once('tauri://error', (event) => {
      debug.error('OAuth popup failed to open:', event)
      settle(() => reject(new Error('Failed to open the sign-in window')))
    })
  })
}

// Called from AuthCallbackView when it runs inside the popup: broadcast the
// result so the main window can take over (it also closes this popup).
export async function notifyOAuthComplete(next: string): Promise<void> {
  const { emit } = await import('@tauri-apps/api/event')
  await emit(OAUTH_COMPLETE_EVENT, { next } satisfies OAuthCompletePayload)
}
