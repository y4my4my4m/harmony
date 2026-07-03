/**
 * Feature flags for the "Today" dashboard (beta).
 *
 * Module-level refs so the settings toggle, the sidebar entry, and the
 * router guard all observe the same state. Persisted per-user via
 * userStorage (localStorage-backed, so per-device: a phone and a desktop
 * decide independently).
 *
 * Defaults when nothing is stored yet:
 *   - dashboard: ON
 *   - AI summaries: probed per device - ON only when the browser's built-in
 *     model is already available. The probe result is NOT persisted; only an
 *     explicit user toggle writes a value, so the same account re-probes on
 *     each device until the user decides.
 */

import { ref } from 'vue'
import { userStorage } from '@/utils/userScopedStorage'

const ENABLED_KEY = 'today-dashboard-enabled'
const AI_KEY = 'today-dashboard-ai-summaries'

const readEnabled = (): boolean => {
  const stored = userStorage.getItem(ENABLED_KEY)
  return stored === null ? true : stored === 'true'
}

const todayDashboardEnabled = ref(readEnabled())
const todayAiSummariesEnabled = ref(userStorage.getItem(AI_KEY) === 'true')

/** Enable AI summaries when unset AND the on-device model is ready to use. */
async function probeAiDefault(): Promise<void> {
  if (userStorage.getItem(AI_KEY) !== null) return
  const Summarizer = (globalThis as any).Summarizer
  if (typeof Summarizer?.availability !== 'function') return
  try {
    if (await Summarizer.availability() === 'available') {
      todayAiSummariesEnabled.value = true
    }
  } catch { /* treat as unsupported */ }
}

void probeAiDefault()

export function useTodayDashboard() {
  const setTodayDashboardEnabled = (enabled: boolean) => {
    todayDashboardEnabled.value = enabled
    userStorage.setItem(ENABLED_KEY, String(enabled))
  }

  const setTodayAiSummariesEnabled = (enabled: boolean) => {
    todayAiSummariesEnabled.value = enabled
    userStorage.setItem(AI_KEY, String(enabled))
  }

  /** Re-read persisted values (userStorage keys are per-user; call after login). */
  const refreshFromStorage = () => {
    todayDashboardEnabled.value = readEnabled()
    todayAiSummariesEnabled.value = userStorage.getItem(AI_KEY) === 'true'
    void probeAiDefault()
  }

  return {
    todayDashboardEnabled,
    todayAiSummariesEnabled,
    setTodayDashboardEnabled,
    setTodayAiSummariesEnabled,
    refreshFromStorage,
  }
}
