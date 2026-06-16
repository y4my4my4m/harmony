import { defineStore } from 'pinia'
import {
  fundingService,
  type FundingConfigWithProgress,
} from '@/services/FundingService'
import { debug } from '@/utils/debug'

// Instance funding bar: load() dedupes via inflight + STALE_MS; works without auth.
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
