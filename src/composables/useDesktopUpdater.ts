import { computed } from 'vue'
import {
  updaterState,
  checkForUpdates,
  downloadUpdate,
  installAndRestart,
  setAutoDownload,
  openUpdatePrompt,
  closeUpdatePrompt,
} from '@/services/desktopUpdater'

export function useDesktopUpdater() {
  const state = updaterState

  const isActive = computed(() =>
    !['unavailable', 'not-configured', 'unsupported'].includes(state.phase),
  )
  const isReady = computed(() => state.phase === 'ready')
  const isBusy = computed(() =>
    ['checking', 'downloading', 'installing'].includes(state.phase),
  )
  // 0..100, or null while the server has not sent Content-Length.
  const downloadPercent = computed(() => {
    if (state.phase !== 'downloading' || !state.totalBytes) return null
    return Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
  })

  return {
    state,
    isActive,
    isReady,
    isBusy,
    downloadPercent,
    checkForUpdates,
    downloadUpdate,
    installAndRestart,
    setAutoDownload,
    openUpdatePrompt,
    closeUpdatePrompt,
  }
}
