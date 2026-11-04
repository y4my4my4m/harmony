import { defineStore } from 'pinia'
import {
  fundingService,
  primeBadgeCache,
  type FundingSummary,
  type ProjectFundingResponse,
} from '@/services/FundingService'
import { debug } from '@/utils/debug'

// One funding read (get_funding_summary) serves the support pill, the Support window and the
// account settings. A load returns the cached copy for FRESH_MS, and past the monthly period's
// end. Nothing polls: the window refreshes when it opens, and returning to the page after a
// payment link was opened refreshes until the donation shows (PAYMENT_RETRY_MS).
export const FRESH_MS = 10 * 60_000
// The project's feed, as this instance's backend caches it.
export const PROJECT_FRESH_MS = 30 * 60_000
// A payment counts as in progress this long after its link was opened.
export const PAYMENT_WINDOW_MS = 60 * 60_000
// Reads after returning from a payment page while no new donation shows: the webhook may lag.
export const PAYMENT_RETRY_MS = [0, 20_000, 60_000] as const
// Least time between two reads triggered by returning to the page.
const RETURN_THROTTLE_MS = 10_000

const PROJECT_HINT_KEY = 'harmony.funding.project-instance'

export type SupportTab = 'instance' | 'project'

function readProjectHint(): boolean | null {
  try {
    const raw = localStorage.getItem(PROJECT_HINT_KEY)
    return raw === 'true' ? true : raw === 'false' ? false : null
  } catch {
    return null
  }
}

function writeProjectHint(value: boolean): void {
  try {
    localStorage.setItem(PROJECT_HINT_KEY, String(value))
  } catch {
    /* storage unavailable */
  }
}

let visibilityHandler: (() => void) | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

export const useFundingStore = defineStore('funding', {
  state: () => ({
    config: null as FundingSummary | null,
    lastLoadedAt: 0,
    inflight: null as Promise<FundingSummary | null> | null,
    /** Bumped by clear(); a load started under an older epoch discards its result. */
    epoch: 0,
    project: null as ProjectFundingResponse | null,
    projectLoadedAt: 0,
    projectInflight: null as Promise<ProjectFundingResponse | null> | null,
    /** Last answer of whether this is the project's instance; null before the first. */
    projectInstanceHint: readProjectHint() as boolean | null,
    /** The Support window: closed, or the tab it opened on. */
    modal: null as SupportTab | null,
    paymentOpenedAt: 0,
    /** Set when a read after a payment found a new donation; the window thanks the donor. */
    thankedAt: 0,
    lastReturnAt: 0,
  }),
  getters: {
    myBadge(state) {
      return state.config?.me?.badge ?? null
    },
    /** True on the Harmony project's own instance: one view, no project tab. */
    isProjectInstance(state): boolean | null {
      if (state.project) return state.project.projectInstance
      return state.projectInstanceHint
    },
  },
  actions: {
    /** An action, not a getter: a getter is cached and does not see the clock move. */
    isStale(): boolean {
      if (!this.config) return true
      if (Date.now() - this.lastLoadedAt > FRESH_MS) return true
      const end = this.config.period_end ? Date.parse(this.config.period_end) : NaN
      return Number.isFinite(end) && Date.now() >= end
    },

    async load(options: { force?: boolean } = {}): Promise<FundingSummary | null> {
      this.watchVisibility()
      if (!options.force && !this.isStale()) return this.config
      if (this.inflight) return this.inflight

      const epoch = this.epoch
      const promise = (async () => {
        try {
          const data = await fundingService.getFundingSummary()
          if (epoch !== this.epoch) return null
          this.config = data
          this.lastLoadedAt = Date.now()
          if (data?.me) primeBadgeCache(data.me.profile_id, data.me.badge)
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

    refresh(): Promise<FundingSummary | null> {
      return this.load({ force: true })
    },

    async loadProject(options: { force?: boolean } = {}): Promise<ProjectFundingResponse | null> {
      const fresh = this.project && Date.now() - this.projectLoadedAt < PROJECT_FRESH_MS
      if (fresh && !options.force) return this.project
      if (this.projectInflight) return this.projectInflight
      const epoch = this.epoch
      const promise = (async () => {
        const data = await fundingService.getProjectFunding()
        if (epoch !== this.epoch) return null
        if (data) {
          this.project = data
          this.projectLoadedAt = Date.now()
          this.projectInstanceHint = data.projectInstance
          writeProjectHint(data.projectInstance)
        }
        return data ?? this.project
      })().finally(() => {
        if (epoch === this.epoch) this.projectInflight = null
      })
      this.projectInflight = promise
      return promise
    },

    openModal(tab: SupportTab = 'instance') {
      this.modal = tab
    },

    closeModal() {
      this.modal = null
    },

    /** A payment link opened in another tab or app: the next return to this page reads again. */
    notePaymentOpened() {
      this.paymentOpenedAt = Date.now()
      this.watchVisibility()
    },

    /** Reads after a payment until a donation newer than the link shows, PAYMENT_RETRY_MS apart. */
    async refreshAfterPayment(attempt = 0): Promise<void> {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      const since = this.paymentOpenedAt
      const data = await this.refresh()
      const latest = data?.me?.donations?.[0]?.donated_at
      if (latest && Date.parse(latest) >= since - 60_000) {
        this.paymentOpenedAt = 0
        this.thankedAt = Date.now()
        return
      }
      const next = PAYMENT_RETRY_MS[attempt + 1]
      if (next === undefined || !this.paymentOpenedAt) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        void this.refreshAfterPayment(attempt + 1)
      }, next - PAYMENT_RETRY_MS[attempt])
    },

    onReturn() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - this.lastReturnAt < RETURN_THROTTLE_MS) return
      this.lastReturnAt = now
      if (this.paymentOpenedAt && now - this.paymentOpenedAt < PAYMENT_WINDOW_MS) {
        void this.refreshAfterPayment()
      } else if (this.config) {
        void this.load()
      }
    },

    watchVisibility() {
      if (visibilityHandler || typeof document === 'undefined') return
      visibilityHandler = () => this.onReturn()
      document.addEventListener('visibilitychange', visibilityHandler)
      // Native clients open payment pages in the system browser; the window regains focus.
      window.addEventListener('focus', visibilityHandler)
    },

    /** Sign-out: drops what was read, including what a running load returns. */
    clear() {
      if (visibilityHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibilityHandler)
        window.removeEventListener('focus', visibilityHandler)
      }
      visibilityHandler = null
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      this.epoch++
      this.config = null
      this.lastLoadedAt = 0
      this.inflight = null
      this.project = null
      this.projectLoadedAt = 0
      this.projectInflight = null
      this.modal = null
      this.paymentOpenedAt = 0
      this.thankedAt = 0
      this.lastReturnAt = 0
    },
  },
})
