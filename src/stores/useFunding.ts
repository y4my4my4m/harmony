import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import {
  fundingService,
  type FundingConfigWithProgress,
} from '@/services/FundingService'
import { debug } from '@/utils/debug'

// Instance funding bar: load() dedupes via inflight + STALE_MS. Without a session it reads nothing.
const STALE_MS = 60_000

export const useFundingStore = defineStore('funding', {
  state: () => ({
    config: null as FundingConfigWithProgress | null,
    lastLoadedAt: 0,
    inflight: null as Promise<FundingConfigWithProgress | null> | null,
    refreshTimer: null as ReturnType<typeof setInterval> | null,
    /** Bumped by clear(); a load started under an older epoch discards its result. */
    epoch: 0,
  }),
  getters: {
    isStale(state): boolean {
      return Date.now() - state.lastLoadedAt > STALE_MS
    },
  },
  actions: {
    async load(options: { force?: boolean } = {}): Promise<FundingConfigWithProgress | null> {
      void this.ensureAutoRefresh()
      if (!options.force && !this.isStale && this.config) {
        return this.config
      }
      if (this.inflight) return this.inflight

      const epoch = this.epoch
      const promise = (async () => {
        try {
          const data = await fundingService.getFundingWithProgress()
          if (epoch !== this.epoch) return null
          this.config = data
          this.lastLoadedAt = Date.now()
          return data
        } catch (err) {
          debug.warn('useFundingStore.load failed:', err)
          return epoch === this.epoch ? this.config : null
        } finally {
          // After clear(), inflight belongs to a newer load.
          if (epoch === this.epoch) this.inflight = null
        }
      })()

      this.inflight = promise
      return promise
    },

    refresh(): Promise<FundingConfigWithProgress | null> {
      return this.load({ force: true })
    },

    /** Starts the background refresh while signed in; clear() stops it at sign-out. */
    async ensureAutoRefresh(): Promise<void> {
      if (this.refreshTimer) return
      const epoch = this.epoch
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session && epoch === this.epoch) this.startAutoRefresh()
      } catch (err) {
        debug.warn('useFundingStore: session read failed:', err)
      }
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

    /** Sign-out: stops the refresh and drops the config, including what a running load returns. */
    clear() {
      this.stopAutoRefresh()
      this.epoch++
      this.config = null
      this.lastLoadedAt = 0
      this.inflight = null
    },
  },
})
