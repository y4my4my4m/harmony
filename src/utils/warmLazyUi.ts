/**
 * Fetches the chunks of UI split out of the entry bundle once the page is idle, so their
 * first open does not wait on the network: the voice dock, the live theme editor and the
 * emoji picker.
 */
export function warmLazyUi(): void {
  const run = () => {
    void import('@/components/voice/UnifiedVoiceDock.vue').catch(() => {})
    void import('@/components/settings/user/ThemeCustomizerPanel.vue').catch(() => {})
    void import('@/components/EmojiPopup.vue').catch(() => {})
  }
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(run, { timeout: 8000 })
  else setTimeout(run, 4000)
}
