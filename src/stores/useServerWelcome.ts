import { defineStore } from 'pinia'
import { debug } from '@/utils/debug'
import {
  acceptServerRules,
  getServerWelcome,
  markServerWelcomeSeen,
  type ServerWelcome,
} from '@/services/ServerWelcomeService'

/**
 * Per-server welcome screen state for the signed-in member, loaded once per session on the
 * first visit to each server. visit() opens the screen when the server answers should_show.
 */

const pendingLoads = new Map<string, Promise<ServerWelcome | null>>()

export const useServerWelcomeStore = defineStore('serverWelcome', {
  state: () => ({
    byServer: {} as Record<string, ServerWelcome>,
    /** Servers whose state could not be loaded this session. */
    failed: {} as Record<string, true>,
    openServerId: null as string | null,
    busy: false,
    error: null as string | null,
  }),

  getters: {
    current(state): ServerWelcome | null {
      return state.openServerId ? state.byServer[state.openServerId] ?? null : null
    },
    mustAccept: (state) => (serverId: string | null | undefined): boolean =>
      !!serverId && !!state.byServer[serverId]?.must_accept,
    /** An enabled screen, or any rules to show. */
    hasScreen: (state) => (serverId: string | null | undefined): boolean => {
      const w = serverId ? state.byServer[serverId] : undefined
      return !!w && (w.enabled || w.rules.length > 0)
    },
  },

  actions: {
    async load(serverId: string, force = false): Promise<ServerWelcome | null> {
      if (!force) {
        if (this.byServer[serverId]) return this.byServer[serverId]
        if (this.failed[serverId]) return null
      }
      const pending = pendingLoads.get(serverId)
      if (pending) return pending

      const request = (async () => {
        try {
          const welcome = await getServerWelcome(serverId)
          this.byServer[serverId] = welcome
          delete this.failed[serverId]
          return welcome
        } catch (error) {
          debug.warn('Server welcome unavailable:', error)
          this.failed[serverId] = true
          return null
        } finally {
          pendingLoads.delete(serverId)
        }
      })()
      pendingLoads.set(serverId, request)
      return request
    },

    /** Opens the screen when the server says this member has not seen it. */
    async visit(serverId: string): Promise<void> {
      const welcome = await this.load(serverId)
      if (welcome?.should_show && !this.openServerId) {
        this.openServerId = serverId
      }
    },

    async open(serverId: string): Promise<void> {
      this.error = null
      const welcome = await this.load(serverId, true)
      if (welcome) this.openServerId = serverId
    },

    /** Closes the screen; the first close records it as seen. */
    async dismiss(): Promise<void> {
      const serverId = this.openServerId
      this.openServerId = null
      this.error = null
      const welcome = serverId ? this.byServer[serverId] : null
      if (!serverId || !welcome?.is_member || welcome.welcome_seen_at) return
      try {
        this.byServer[serverId] = await markServerWelcomeSeen(serverId)
      } catch (error) {
        debug.warn('Could not record the welcome screen as seen:', error)
        this.byServer[serverId] = { ...welcome, should_show: false }
      }
    },

    async accept(): Promise<boolean> {
      const serverId = this.openServerId
      if (!serverId || this.busy) return false
      this.busy = true
      this.error = null
      try {
        this.byServer[serverId] = await acceptServerRules(serverId)
        this.openServerId = null
        return true
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        return false
      } finally {
        this.busy = false
      }
    },

    /** A send was refused with RULES_NOT_ACCEPTED: the cached state is stale. */
    async handleRulesRejection(serverId: string | null | undefined): Promise<void> {
      if (!serverId) return
      const welcome = await this.load(serverId, true)
      if (!welcome) return
      if (!welcome.must_accept) {
        this.byServer[serverId] = { ...welcome, must_accept: true }
      }
    },

    reset(): void {
      this.byServer = {}
      this.failed = {}
      this.openServerId = null
      this.busy = false
      this.error = null
      pendingLoads.clear()
    },
  },
})
