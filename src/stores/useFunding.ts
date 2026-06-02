/**
 * useFundingStore
 *
 * Single source of truth for the instance funding bar (the goal +
 * progress shown in the context bar). Replaces the duplicate
 * `fundingService.getFundingWithProgress()` fetch that previously lived
 * in every layout / component that wanted to display the bar.
 *
 * Behaviour:
 *   - `load({ force? })` fetches the config + computed progress.
 *     Subsequent calls within `STALE_MS` are no-ops unless `force` is set.
 *   - `inflight` deduplicates concurrent callers (e.g. ChatLayout +
 *     SocialLayout both mounting on a fast route swap).
 *   - A 60s background refresh keeps the progress bar live without
 *     hitting the DB on every navigation.
 *
 * Note: the funding bar is intentionally public - `getFundingWithProgress`
 * works without an auth session, so we can prime it as early as
 * `useAuthStore.initializeAuth()` regardless of whether the user is
 * signed in.
 */

import { defineStore } from 'pinia'
import {
  fundingService,
  type FundingConfigWithProgress,
} from '@/services/FundingService'
import { debug } from '@/utils/debug'

const STALE_MS = 60_000

export const useFundingStore = defineStore('funding', {
  state: () => ({
    config: null as FundingConfigWithProgress | null,
    lastLoadedAt: 0,
    inflight: null as Promise<FundingConfigWithProgress | null> | null,
    refreshTimer: null as ReturnType<typeof setInterval> | null,
  }),
  getters: {
    isStale(state): boolean {
      return Date.now() - state.lastLoadedAt > STALE_MS
    },
  },
  actions: {
    async load(options: { force?: boolean } = {}): Promise<FundingConfigWithProgress | null> {
      if (!options.force && !this.isStale && this.config) {
        return this.config
      }
      if (this.inflight) return this.inflight

      const promise = (async () => {
        try {
          const data = await fundingService.getFundingWithProgress()
          this.config = data
          this.lastLoadedAt = Date.now()
          return data
        } catch (err) {
          debug.warn('useFundingStore.load failed:', err)
          return this.config
        } finally {
          this.inflight = null
        }
      })()

      this.inflight = promise
      return promise
    },

    refresh(): Promise<FundingConfigWithProgress | null> {
      return this.load({ force: true })
    },

    /**
     * Start a low-frequency background refresh so progress ticks without
     * router navigation. Safe to call multiple times - second call is a no-op.
     */
    startAutoRefresh(intervalMs = STALE_MS) {
      if (this.refreshTimer) return
      this.refreshTimer = setInterval(() => {
        void this.refresh()
      }, intervalMs)
    },

    stopAutoRefresh() {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer)
        this.refreshTimer = null
      }
    },
  },
})
