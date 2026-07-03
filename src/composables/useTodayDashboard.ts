/**
 * Feature flags for the "Today" dashboard (beta).
 *
 * Module-level refs so the settings toggle, the sidebar entry, and the
 * router guard all observe the same state. Persisted per-user via
 * userStorage.
 */

import { ref } from 'vue'
import { userStorage } from '@/utils/userScopedStorage'

const ENABLED_KEY = 'today-dashboard-enabled'
const AI_KEY = 'today-dashboard-ai-summaries'

const todayDashboardEnabled = ref(userStorage.getItem(ENABLED_KEY) === 'true')
const todayAiSummariesEnabled = ref(userStorage.getItem(AI_KEY) === 'true')

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
    todayDashboardEnabled.value = userStorage.getItem(ENABLED_KEY) === 'true'
    todayAiSummariesEnabled.value = userStorage.getItem(AI_KEY) === 'true'
  }

  return {
    todayDashboardEnabled,
    todayAiSummariesEnabled,
    setTodayDashboardEnabled,
    setTodayAiSummariesEnabled,
    refreshFromStorage,
  }
}
